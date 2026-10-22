/**
 * Synthetic browser client: one fleet connection behind a TransportAdapter,
 * instrumented with the measurements the scenarios report.
 *
 * - command RTT: `call()` stamps the command send and the matching `call_result`
 *   frame's receive time (both `monotonicNs()`); the socket's ack is not the answer.
 * - stream latency: every main-session `text_delta` becomes a RecvRecord keyed
 *   (route, req, contentIndex, cumulative offset) exactly as latency.ts
 *   documents; deltas received while an attach is still priming are excluded.
 * - TTFF: `attach()` timestamps `attached`, the final `history` chunk and the
 *   end of the priming group (`available_commands`) relative to the attach send.
 * - reconnect/resume: `reconnect()` drops the socket, redials it with the
 *   last seen seq (`after`) and re-attaches, as apps/web/state.ts does.
 * - frames and bytes per frame type, for H1 throughput.
 */
import { randomUUID } from "node:crypto";
import { monotonicNs } from "./clock";
import type { RecvRecord } from "./latency";
import type { ReceivedFrame, TransportAdapter, TransportConnection } from "./types";

/** The server closed the socket while a call was waiting on it (non-resilient clients). */
export class DownlinkEnded extends Error {}

/** A resilient client could not redial or re-attach after a drop: the rep cannot continue. */
export class RecoveryFailed extends Error {}

/** One unexpected socket close and how the client recovered, as the web client's reconnect would. */
export interface DropRecord {
	/** How the socket ended (`closed` = the server's close frame, e.g. 4503 slow consumer; `error` = abnormal close or protocol violation). */
	how: string;
	/** Close code and reason of the socket (`4503 slow_consumer: ...`, `1006 Connection ended`). */
	close?: string;
	/** Last frame types received before the end, oldest first. */
	lastTypes: string[];
	/** Bytes and frames received since the last `attached` frame (the priming burst in progress). */
	bytesSinceAttached: number;
	framesSinceAttached: number;
	/** Close to socket redialed and the session re-attached and primed; undefined until recovered. */
	recoveryMs?: number;
	/** Open/attach attempts the recovery needed. */
	attempts?: number;
}

export interface ConnectOptions {
	/**
	 * Behave like the web client's reconnect plus the UI's onopen re-attach: on an
	 * unexpected socket close redial with `after`, re-attach and carry on, counting a
	 * drop. Default true. When false the close rejects waiters with DownlinkEnded.
	 */
	resilient?: boolean;
}

const MAX_RECOVERY_ATTEMPTS = 5;
const RECOVERY_RETRY_MS = 100;
const RECOVERY_ATTACH_TIMEOUT_MS = 30_000;
/** How long a prompt answered "not attached" waits for the edge to re-attach before it fails. */
const REATTACH_WAIT_MS = 30_000;
/** Frame types kept for drop diagnostics. */
const RECENT_TYPES = 8;

const NS_PER_MS = 1_000_000;

export function nsToMs(ns: bigint): number {
	return Number(ns) / NS_PER_MS;
}

export interface TypeCount {
	frames: number;
	bytes: number;
}

export interface AttachTimings {
	/** Attach command acked by the server. */
	acceptMs: number;
	/** First session frame (`attached`). */
	ttffMs: number;
	/** Final `history` chunk received. */
	historyMs: number;
	/** Priming group complete (`available_commands` after history and state). */
	primedMs: number;
	historyFrames: number;
	historyBytes: number;
	primingFrames: number;
	primingBytes: number;
	/** `attached` frames seen before priming completed; more than 1 means the stream was re-primed mid-attach. */
	attachedFrames: number;
}

export interface ReconnectTimings {
	/** Close to socket open (the upgrade completed). */
	openMs: number;
	/** Close to first frame of the new socket (replayed or primed). */
	firstFrameMs: number;
	/** Close to the first frame whose seq is beyond everything seen before the close (resumed with `after`). */
	resumeMs: number;
	/** Close to re-attach priming complete. */
	reattachPrimedMs: number;
	/** Frames received between reopen and the end of re-attach priming. */
	replayFrames: number;
}

export interface CallResult {
	ok: boolean;
	data?: unknown;
	error?: string;
	/** Command send to call_result receive. */
	rttMs: number;
	/** Command send to the server's ack (uplink only). */
	acceptMs: number;
}

export interface TurnTimings {
	/** prompt call start to `agent_end` receive. */
	turnMs: number;
	/** prompt call start to first text delta. */
	firstDeltaMs: number | undefined;
}

type Frame = ReceivedFrame["frame"];

/** The parts of an `event` frame's SDK event this client reads. */
interface WireEvent {
	type: string;
	message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
	assistantMessageEvent?: { type: string; contentIndex?: number; delta?: string };
}

/** True for a `state` frame whose session is not streaming. */
function isIdleState(frame: Frame): boolean {
	return (
		frame.type === "state" &&
		typeof frame.state === "object" &&
		frame.state !== null &&
		"isStreaming" in frame.state &&
		frame.state.isStreaming === false
	);
}

/** Narrow an `event` frame to its event payload; anything else is undefined. */
function eventOf(frame: Frame): WireEvent | undefined {
	if (frame.type !== "event" || typeof frame.event !== "object" || frame.event === null) {
		return undefined;
	}
	// Server-produced JSON (lib/wire/protocol.ts WireSessionEvent); only the fields above are read.
	const event: WireEvent = frame.event as WireEvent;
	return event;
}

interface Waiter {
	/** `recovery` waiters belong to a re-attach and are rejected when that re-attach's stream drops again. */
	owner: "user" | "recovery";
	pred: (r: ReceivedFrame) => boolean;
	resolve: (r: ReceivedFrame) => void;
	reject: (err: Error) => void;
}

export class ProfileClient {
	readonly clientId = randomUUID();
	readonly byType: Record<string, TypeCount> = {};
	/** Joinable text deltas of the attached session (excludes priming windows). */
	readonly recv: RecvRecord[] = [];
	frames = 0;
	frameBytes = 0;
	/** `message_end` text lengths that disagree with the accumulated deltas (lossy/duplicated stream). */
	lengthMismatches = 0;
	/** Text deltas not recorded for latency because a reconnect or resync left the message ordinal unknown. */
	excludedDeltas = 0;
	/** Every unexpected downlink end since connect, in order. */
	readonly dropLog: DropRecord[] = [];
	route = "";
	readonly #resilient: boolean;
	readonly #adapter: TransportAdapter;
	readonly #baseUrl: string;
	#conn!: TransportConnection;
	/** Bytes of connections already replaced by reconnect(). */
	#priorBytesDown = 0;
	#priorBytesUp = 0;
	readonly #waiters = new Set<Waiter>();
	#listeners = new Set<(r: ReceivedFrame) => void>();
	#priming = false;
	/** Inside a multi-chunk `history` series (`final: false` seen, `final` not yet). */
	#inHistorySeries = false;
	/** Set while this client itself ends the downlink (reconnect, close). */
	#expectedEnd = false;
	#historyAssistant = 0;
	#liveAssistant = 0;
	readonly #offsets = new Map<string, number>();
	/** The session this client is attached to; recovery re-attaches it. */
	#attachedTo: { daemonId: string; route: string } | undefined;
	#recovering: Promise<void> | undefined;
	#fatal: RecoveryFailed | undefined;
	#recoveries = 0;
	/** The message ordinal is unknown (after an attach or resync) until a fresh assistant message starts. */
	#suspect = false;
	#historySettled = false;
	/** False between an `attached` frame and the end of its priming group (`available_commands`). */
	#primeDone = true;
	readonly #recentTypes: string[] = [];
	#attachedCount = 0;
	#bytesSinceAttached = 0;
	#framesSinceAttached = 0;

	private constructor(adapter: TransportAdapter, baseUrl: string, resilient: boolean) {
		this.#adapter = adapter;
		this.#baseUrl = baseUrl;
		this.#resilient = resilient;
	}

	static async connect(
		adapter: TransportAdapter,
		baseUrl: string,
		options: ConnectOptions = {},
	): Promise<ProfileClient> {
		const client = new ProfileClient(adapter, baseUrl, options.resilient ?? true);
		await client.#open(undefined);
		return client;
	}

	async #open(after: number | undefined): Promise<void> {
		// The connection being replaced keeps counting toward the totals.
		const previous: TransportConnection | undefined = this.#conn;
		if (previous !== undefined) {
			this.#priorBytesDown += previous.bytesDown;
			this.#priorBytesUp += previous.bytesUp;
		}
		this.#conn = await this.#adapter.open({
			baseUrl: this.#baseUrl,
			clientId: this.clientId,
			...(after !== undefined ? { after } : {}),
		});
		const conn = this.#conn;
		conn.onFrame((r) => this.#onFrame(r));
		// A socket the server closed unexpectedly (for example the edge's 4503 slow-consumer
		// drop-and-resume): a resilient client recovers like the web client; otherwise waiters fail.
		void conn.ended.then((how) => {
			if (this.#conn !== conn || this.#expectedEnd) return;
			const err = new DownlinkEnded(
				`socket closed unexpectedly (${how}, ${conn.closeInfo ?? "no close info"}) while waiting`,
			);
			if (!this.#resilient) {
				this.#rejectWaiters(err, () => true);
			} else if (this.#recovering !== undefined) {
				// The re-attach's own socket closed again; the recovery loop retries.
				this.#rejectWaiters(err, (w) => w.owner === "recovery");
			} else {
				this.#recovering = this.#recover(how).finally(() => {
					this.#recovering = undefined;
				});
			}
		});
	}

	#rejectWaiters(err: Error, which: (w: Waiter) => boolean): void {
		for (const waiter of this.#waiters) {
			if (!which(waiter)) continue;
			this.#waiters.delete(waiter);
			waiter.reject(err);
		}
	}

	/** Redial with `after` and re-attach until it works; fatal after MAX_RECOVERY_ATTEMPTS. */
	async #recover(how: string): Promise<void> {
		const record: DropRecord = {
			how,
			...(this.#conn.closeInfo !== undefined ? { close: this.#conn.closeInfo } : {}),
			lastTypes: [...this.#recentTypes],
			bytesSinceAttached: this.#bytesSinceAttached,
			framesSinceAttached: this.#framesSinceAttached,
		};
		this.dropLog.push(record);
		const t0 = monotonicNs();
		let lastError: unknown;
		for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
			try {
				await this.#open(this.#conn.lastSeq);
				const target = this.#attachedTo;
				if (target !== undefined) {
					await this.attach(target.daemonId, target.route, RECOVERY_ATTACH_TIMEOUT_MS, "recovery");
				}
				record.recoveryMs = nsToMs(monotonicNs() - t0);
				record.attempts = attempt;
				this.#recoveries++;
				return;
			} catch (err) {
				lastError = err;
				await Bun.sleep(RECOVERY_RETRY_MS);
			}
		}
		const fatal = new RecoveryFailed(
			`could not recover the socket after ${MAX_RECOVERY_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
		);
		this.#fatal = fatal;
		this.#rejectWaiters(fatal, () => true);
	}

	get bytesDown(): number {
		return this.#priorBytesDown + this.#conn.bytesDown;
	}

	get bytesUp(): number {
		return this.#priorBytesUp + this.#conn.bytesUp;
	}

	get ended(): TransportConnection["ended"] {
		return this.#conn.ended;
	}

	/** Zero the per-type frame counters (call at the start of a measured window). */
	resetCounters(): void {
		for (const key of Object.keys(this.byType)) delete this.byType[key];
		this.frames = 0;
		this.frameBytes = 0;
		this.recv.length = 0;
		this.lengthMismatches = 0;
		this.excludedDeltas = 0;
	}

	onFrame(cb: (r: ReceivedFrame) => void): () => void {
		this.#listeners.add(cb);
		return () => this.#listeners.delete(cb);
	}

	/**
	 * Resolves with the first frame (arriving AFTER this call) matching `pred`. Aborting `signal`
	 * removes the waiter and clears its timer (the wait rejects with the abort reason), so a caller
	 * that stops caring does not leave a timer and a waiter behind.
	 */
	waitFrame(
		pred: (r: ReceivedFrame) => boolean,
		timeoutMs: number,
		what: string,
		owner: Waiter["owner"] = "user",
		signal?: AbortSignal,
	): Promise<ReceivedFrame> {
		const { promise, resolve, reject } = Promise.withResolvers<ReceivedFrame>();
		if (this.#fatal !== undefined) {
			reject(this.#fatal);
			return promise;
		}
		if (signal?.aborted === true) {
			reject(signal.reason);
			return promise;
		}
		const waiter: Waiter = {
			owner,
			pred,
			resolve: (r) => {
				clearTimeout(timer);
				resolve(r);
			},
			reject: (err) => {
				clearTimeout(timer);
				reject(err);
			},
		};
		const timer = setTimeout(() => {
			this.#waiters.delete(waiter);
			reject(new Error(`timed out waiting for ${what} (${timeoutMs}ms)`));
		}, timeoutMs);
		signal?.addEventListener(
			"abort",
			() => {
				this.#waiters.delete(waiter);
				waiter.reject(signal.reason);
			},
			{ once: true },
		);
		this.#waiters.add(waiter);
		return promise;
	}

	/** Frame waiters still registered (a settled wait has none left); a leak check for tests. */
	get pendingWaiters(): number {
		return this.#waiters.size;
	}

	#onFrame(r: ReceivedFrame): void {
		const frame = r.frame;
		this.frames++;
		this.frameBytes += r.bytes;
		const count = (this.byType[frame.type] ??= { frames: 0, bytes: 0 });
		count.frames++;
		count.bytes += r.bytes;
		this.#recentTypes.push(frame.type);
		if (this.#recentTypes.length > RECENT_TYPES) this.#recentTypes.shift();
		if (frame.type === "attached") {
			this.#attachedCount++;
			this.#bytesSinceAttached = 0;
			this.#framesSinceAttached = 0;
		}
		this.#bytesSinceAttached += r.bytes;
		this.#framesSinceAttached++;
		this.#track(r, frame);
		for (const cb of this.#listeners) cb(r);
		for (const waiter of this.#waiters) {
			if (waiter.pred(r)) {
				this.#waiters.delete(waiter);
				waiter.resolve(r);
			}
		}
	}

	#track(r: ReceivedFrame, frame: Frame): void {
		if (frame.type === "attached") {
			this.#historyAssistant = 0;
			this.#liveAssistant = 0;
			this.#offsets.clear();
			this.#suspect = true;
			this.#historySettled = false;
			this.#primeDone = false;
			return;
		}
		if (frame.type === "available_commands") {
			this.#primeDone = true;
			return;
		}
		if (frame.type === "history") {
			// A new history series (attach priming or a resync after a transcript rewrite) restates
			// the whole transcript, so the assistant ordinal restarts from what it contains.
			if (!this.#inHistorySeries) {
				this.#historyAssistant = 0;
				this.#liveAssistant = 0;
				this.#offsets.clear();
				this.#suspect = true;
			}
			this.#inHistorySeries = frame.final === false;
			this.#historySettled = !this.#inHistorySeries;
			// History frame payload (lib/wire/protocol.ts): messages carry a role.
			const messages: Array<{ role?: string }> = Array.isArray(frame.messages)
				? frame.messages
				: [];
			for (const m of messages) if (m.role === "assistant") this.#historyAssistant++;
			return;
		}
		const event = eventOf(frame);
		if (event === undefined) return;
		if (event.type === "message_start" && event.message?.role === "assistant") {
			this.#liveAssistant++;
			// A message that starts after the attach priming group ended (available_commands) and
			// the history settled is fresh, so its ordinal is known. The in-progress message the
			// edge primes a late joiner with arrives inside the priming group and stays excluded.
			if (this.#historySettled && this.#primeDone) this.#suspect = false;
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const req = this.#req();
			event.message.content?.forEach((block, index) => {
				if (block.type !== "text" || block.text === undefined) return;
				const got = this.#offsets.get(`${req}:${index}`);
				if (got !== undefined && got !== block.text.length) this.lengthMismatches++;
			});
			return;
		}
		if (event.type !== "message_update") return;
		const ev = event.assistantMessageEvent;
		if (ev?.type !== "text_delta" || ev.delta === undefined || ev.contentIndex === undefined)
			return;
		const req = this.#req();
		const key = `${req}:${ev.contentIndex}`;
		const offset = (this.#offsets.get(key) ?? 0) + ev.delta.length;
		this.#offsets.set(key, offset);
		if (this.#priming || this.route === "") return;
		if (this.#suspect) {
			this.excludedDeltas++;
			return;
		}
		this.recv.push({
			route: this.route,
			req,
			contentIndex: ev.contentIndex,
			offset,
			recvNs: r.recvNs,
		});
	}

	/** 0-based assistant message ordinal of the message currently streaming. */
	#req(): number {
		return this.#historyAssistant + this.#liveAssistant - 1;
	}

	/** Uplink a raw command (no result wait). */
	async send(command: Record<string, unknown>): Promise<void> {
		await this.#recovering;
		if (this.#fatal !== undefined) throw this.#fatal;
		await this.#conn.send(command);
	}

	/** `call` command: RTT from the command send to the matching `call_result` frame (the ack is not the answer). */
	async call(method: string, args: unknown[] = [], timeoutMs = 60_000): Promise<CallResult> {
		const id = randomUUID();
		const result = this.waitFrame(
			(r) => r.frame.type === "call_result" && r.frame.id === id,
			timeoutMs,
			`call_result ${method}`,
		);
		result.catch(() => undefined);
		const t0 = monotonicNs();
		await this.send({ type: "call", id, method, args });
		const acceptNs = monotonicNs();
		const answer = await result;
		const { frame } = answer;
		return {
			ok: frame.ok === true,
			data: frame.data,
			...(typeof frame.error === "string" ? { error: frame.error } : {}),
			rttMs: nsToMs(answer.recvNs - t0),
			acceptMs: nsToMs(acceptNs - t0),
		};
	}

	/**
	 * Fire `method` every `intervalMs` until the returned stop() is awaited;
	 * resolves to the RTT samples (ms). Probes never overlap.
	 */
	startRttProbe(
		method: string,
		intervalMs: number,
	): { stop(): Promise<{ rttMs: number[]; failures: number }> } {
		const rtts: number[] = [];
		let failures = 0;
		let running = true;
		const loop = (async () => {
			while (running) {
				const tick = Bun.sleep(intervalMs);
				try {
					const res = await this.call(method, [], 15_000);
					if (res.ok) rtts.push(res.rttMs);
					else failures++;
				} catch {
					failures++;
				}
				await tick;
			}
		})();
		return {
			stop: async () => {
				running = false;
				await loop;
				return { rttMs: rtts, failures };
			},
		};
	}

	/** Attach to `daemonId` (fleet edge) and measure priming. `route` labels latency records. */
	async attach(
		daemonId: string,
		route: string,
		timeoutMs = 60_000,
		owner: Waiter["owner"] = "user",
	): Promise<AttachTimings> {
		const id = randomUUID();
		this.route = route;
		this.#priming = true;
		let historyFrames = 0;
		let historyBytes = 0;
		let primingFrames = 0;
		let primingBytes = 0;
		let attachedFrames = 0;
		let attachedNs: bigint | undefined;
		let historyNs: bigint | undefined;
		const off = this.onFrame((r) => {
			primingFrames++;
			primingBytes += r.bytes;
			if (r.frame.type === "attached") {
				attachedFrames++;
				attachedNs ??= r.recvNs;
			}
			if (r.frame.type === "history") {
				historyFrames++;
				historyBytes += r.bytes;
				if (r.frame.final !== false) historyNs = r.recvNs;
			}
		});
		try {
			const primed = this.waitFrame(
				(r) => r.frame.type === "available_commands" && historyNs !== undefined,
				timeoutMs,
				`attach priming of ${daemonId}`,
				owner,
			);
			primed.catch(() => undefined);
			const result = this.waitFrame(
				(r) => r.frame.type === "attach_result" && r.frame.id === id,
				timeoutMs,
				"attach_result",
				owner,
			);
			result.catch(() => undefined);
			const t0 = monotonicNs();
			await this.#conn.send({ type: "attach", id, sessionId: daemonId });
			const acceptNs = monotonicNs();
			const attachResult = await result;
			if (attachResult.frame.ok !== true) {
				throw new Error(`attach ${daemonId} failed: ${String(attachResult.frame.error)}`);
			}
			const end = await primed;
			this.#attachedTo = { daemonId, route };
			return {
				acceptMs: nsToMs(acceptNs - t0),
				ttffMs: nsToMs((attachedNs ?? end.recvNs) - t0),
				historyMs: nsToMs((historyNs ?? end.recvNs) - t0),
				primedMs: nsToMs(end.recvNs - t0),
				historyFrames,
				historyBytes,
				primingFrames,
				primingBytes,
				attachedFrames,
			};
		} finally {
			off();
			this.#priming = false;
		}
	}

	/** Send a `prompt` call; resolves at the turn's `agent_end` event. */
	async prompt(
		text: string,
		timeoutMs = 120_000,
		reattachWaitMs = REATTACH_WAIT_MS,
	): Promise<TurnTimings> {
		const settled = new AbortController();
		let firstDeltaNs: bigint | undefined;
		const off = this.onFrame((r) => {
			if (firstDeltaNs !== undefined) return;
			if (eventOf(r.frame)?.assistantMessageEvent?.type === "text_delta") firstDeltaNs = r.recvNs;
		});
		try {
			// The turn is over at `agent_end`, or, if the stream was re-primed meanwhile (a
			// dropped stream recovered by this client, or an edge re-prime after a pair
			// replacement or resync; the event may have been lost in the gap), at an idle `state`
			// frame that follows the re-prime, as the UI would see.
			const attachedAtStart = this.#attachedCount;
			// Moved forward when the prompt is re-sent after a re-attach (see below), so the
			// re-attach's own idle state does not end a turn that has not started yet.
			let rePrimeBase = attachedAtStart;
			const end = this.waitFrame(
				(r) =>
					eventOf(r.frame)?.type === "agent_end" ||
					(this.#attachedCount > rePrimeBase && isIdleState(r.frame)),
				timeoutMs,
				"agent_end",
				"user",
				settled.signal,
			);
			end.catch(() => undefined);
			const t0 = monotonicNs();
			const id = randomUUID();
			const post = async (): Promise<ReceivedFrame> => {
				const callResult = this.waitFrame(
					(r) => r.frame.type === "call_result" && r.frame.id === id,
					timeoutMs,
					"prompt call_result",
					"user",
					settled.signal,
				);
				callResult.catch(() => undefined);
				await this.send({ type: "call", id, method: "prompt", args: [text] });
				// The call_result can be lost with a dropped stream; the turn's end settles the wait too.
				return Promise.race([callResult, end]);
			};
			let first = await post();
			// A command that lands in the few ms between two callback pairs (a pair redial)
			// is answered "not attached" by the edge. The UI parks such a call and re-sends the
			// SAME id on the next `attached` frame (apps/web/store/transport.ts), the session
			// dedups by id; do the same instead of failing the scenario.
			if (
				first.frame.type === "call_result" &&
				first.frame.ok !== true &&
				first.frame.error === "not attached"
			) {
				console.error(
					'[profile] prompt answered "not attached" between two callback pairs; re-sending the same id after the re-attach (as the UI does)',
				);
				const seen = this.#attachedCount;
				await this.waitFrame(
					() => this.#attachedCount > seen,
					reattachWaitMs,
					"re-attach after a not-attached prompt",
					"user",
					settled.signal,
				);
				rePrimeBase = this.#attachedCount;
				first = await post();
			}
			if (first.frame.type === "call_result" && first.frame.ok !== true) {
				throw new Error(`prompt rejected: ${String(first.frame.error)}`);
			}
			let done: ReceivedFrame;
			try {
				done = await end;
			} catch (err) {
				if (err instanceof RecoveryFailed) throw err;
				throw new Error(
					`${err instanceof Error ? err.message : String(err)} [diagnostics: ${this.dropLog.length} drops, ${this.#recoveries} recoveries, ${this.#attachedCount - attachedAtStart} re-primes since the prompt, last frames: ${this.#recentTypes.join(", ")}]`,
				);
			}
			return {
				turnMs: nsToMs(done.recvNs - t0),
				firstDeltaMs: firstDeltaNs === undefined ? undefined : nsToMs(firstDeltaNs - t0),
			};
		} finally {
			// Whatever is still waiting (the turn end after a failure, a call_result lost with a
			// dropped stream) is released, with its timer.
			settled.abort();
			off();
		}
	}

	/**
	 * Network-loss drill: terminate the socket, redial with `after` (the last seq
	 * seen), then re-attach (the edge keeps no attach memory across a reconnect).
	 */
	async reconnect(daemonId: string, route: string): Promise<ReconnectTimings> {
		const lastSeq = this.#conn.lastSeq;
		const lastSeen = lastSeq ?? -1;
		const previous = this.#conn;
		const t0 = monotonicNs();
		this.#expectedEnd = true;
		previous.drop();
		await previous.ended;
		this.#expectedEnd = false;
		let firstNs: bigint | undefined;
		let resumeNs: bigint | undefined;
		let frames = 0;
		const off = this.onFrame((r) => {
			frames++;
			firstNs ??= r.recvNs;
			if (resumeNs === undefined && r.seq !== undefined && r.seq > lastSeen) {
				resumeNs = r.recvNs;
			}
		});
		try {
			await this.#open(lastSeq);
			const openedNs = monotonicNs();
			const attach = await this.attach(daemonId, route);
			void attach;
			const primedNs = monotonicNs();
			return {
				openMs: nsToMs(openedNs - t0),
				firstFrameMs: nsToMs((firstNs ?? primedNs) - t0),
				resumeMs: nsToMs((resumeNs ?? primedNs) - t0),
				reattachPrimedMs: nsToMs(primedNs - t0),
				replayFrames: frames,
			};
		} finally {
			off();
		}
	}

	/** Drop the downlink without reopening (the pair-redial scenario uses the stream state). */
	async close(): Promise<void> {
		this.#expectedEnd = true;
		await this.#conn.close();
	}
}
