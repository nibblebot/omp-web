/**
 * Per-session collab HOST adapter for the omp-web daemon.
 *
 * Mirrors `@oh-my-pi/pi-coding-agent/src/collab/host.ts` (CollabHost) wire
 * behavior against a slim `CollabSessionPort` abstraction over the daemon's
 * SDK sessions, minus all TUI concerns. Guests (real `omp join` clients)
 * connect through the daemon's relay room; this adapter taps the session's
 * event stream and append chokepoint and broadcasts entries/events/state to
 * them, and routes guest prompts/aborts/agent-cmds/ui-responses/transcript
 * fetches into the port.
 */

import { timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import type {
	BusChannel,
	CollabUiRequest,
	CollabUiRequestDraft,
	CollabUiResponseValue,
	ContextUsage,
	AgentEvent as WireAgentEvent,
	SessionEntry as WireSessionEntry,
} from "@oh-my-pi/pi-wire";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { stripImagesFromMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import type {
	SessionEntry,
	SessionHeader,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import {
	generateRoomKey,
	generateWriteToken,
	importRoomKey,
} from "@oh-my-pi/pi-coding-agent/collab/crypto";
import {
	type AgentSnapshot,
	COLLAB_PROTO,
	type CollabFrame,
	type CollabParticipant,
	type CollabSessionState,
	formatCollabLink,
	generateRoomId,
	parseCollabLink,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import { shrinkForReplication } from "@oh-my-pi/pi-coding-agent/collab/replication-shrink";

/** Events that change the footer state guests render. */
const STATE_TRIGGER_EVENTS: Record<string, true> = {
	agent_start: true,
	agent_end: true,
	message_end: true,
	tool_execution_end: true,
	thinking_level_changed: true,
	model_changed: true,
	auto_compaction_end: true,
};

const STATE_DEBOUNCE_MS = 100;
const AGENTS_DEBOUNCE_MS = 100;
const STREAMING_STATE_INTERVAL_MS = 2000;
const WELCOME_IMAGE_STRIP_THRESHOLD = 24 * 1024 * 1024;
const WIRE_AGENT_EVENT_TYPES: Record<WireAgentEvent["type"], true> = {
	agent_start: true,
	agent_end: true,
	turn_start: true,
	turn_end: true,
	message_start: true,
	message_update: true,
	message_end: true,
	tool_execution_start: true,
	tool_execution_update: true,
	tool_execution_end: true,
	notice: true,
	auto_compaction_start: true,
	auto_compaction_end: true,
	auto_retry_start: true,
	auto_retry_end: true,
	thinking_level_changed: true,
};

const WIRE_SESSION_ENTRY_TYPES: Record<WireSessionEntry["type"], true> = {
	message: true,
	custom_message: true,
	compaction: true,
	branch_summary: true,
	model_change: true,
	thinking_level_change: true,
};

function isWireAgentEvent(event: AgentSessionEvent): event is AgentSessionEvent & WireAgentEvent {
	return event.type in WIRE_AGENT_EVENT_TYPES;
}

function isWireSessionEntry(entry: SessionEntry): entry is SessionEntry & WireSessionEntry {
	return entry.type in WIRE_SESSION_ENTRY_TYPES;
}

const CONNECT_TIMEOUT_MS = 15_000;
/** Max bytes served per fetch-transcript reply (guest re-requests from `newSize`). */
export const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024;
const TRANSCRIPT_ENTRY_TOO_LARGE_ERROR = `transcript entry exceeds transcript fetch cap (${TRANSCRIPT_READ_CAP} bytes)`;
/**
 * Soft byte cap per `snapshot-chunk` frame (mirrors CollabHost): the first MB
 * of a snapshot takes ~3s through the default relay, so a 512 KB chunk lands
 * well under the guest's 30 s per-chunk progress timeout; oversized single
 * entries still ship in a chunk of their own.
 */
const SNAPSHOT_CHUNK_BYTES = 512 * 1024;

/** Agent roster entry the port exposes to collab guests. */
export interface CollabAgentRef {
	id: string;
	kind: "main" | "sub";
	displayName: string;
	status: "running" | "idle" | "parked" | "aborted";
	parentId?: string;
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
}

/**
 * The daemon's per-session surface the collab host adapter drives. The web
 * server (Slice C) implements this against a live SDK session; tests use a
 * fake.
 */
export interface CollabSessionPort {
	getSessionId(): string;
	getCwd(): string;
	getSessionName(): string | undefined;
	isStreaming(): boolean;
	isAborting(): boolean;
	queuedMessageCount(): number;
	getModel(): Model | undefined;
	getThinkingLevel(): string | undefined;
	getContextUsage(): ContextUsage | undefined; // {tokens, contextWindow, percent} | undefined
	/** sessionManager.snapshotForReplication() */
	snapshot(): { header: SessionHeader; entries: SessionEntry[] };
	/** session.subscribe — returns unsubscribe */
	subscribe(cb: (event: AgentSessionEvent) => void): () => void;
	/** sessionManager.onEntryAppended = cb (single slot; save+restore previous) */
	onEntryAppended(cb: (entry: SessionEntry) => void): void;
	/** BOTH task channels */
	subscribeBus(cb: (channel: BusChannel, data: unknown) => void): () => void;
	/** Fires when the roster may have changed */
	subscribeAgents(cb: () => void): () => void;
	emitNotice(level: "info" | "warning" | "error", message: string, source?: string): void;
	promptFromGuest(
		text: string,
		images: ImageContent[] | undefined,
		fromName: string,
	): Promise<void>;
	abort(): Promise<void>;
	listAgents(): CollabAgentRef[];
	agentCmd(
		cmd: "chat" | "kill" | "revive",
		agentId: string,
		text: string | undefined,
	): Promise<void>;
	resolveTranscriptFile(agentId: string): string | null;
}

/**
 * Outcome of {@link CollabHostAdapter.requestGuestUi}. `answered` carries the
 * guest's response (an `undefined` value is a genuine guest cancel);
 * `unavailable` means the collab channel went away (teardown, relay drop) or
 * the request was aborted before any guest answered — callers MUST NOT treat
 * it as a cancel.
 */
export type CollabGuestUiResult =
	| { kind: "answered"; value: CollabUiResponseValue }
	| { kind: "unavailable" };

/** Web-visible host status; `null` (and `isLive === false`) when not live. */
export interface CollabHostStatus {
	state: "live" | "error";
	error?: string;
	link: string;
	viewLink: string;
	relayUrl: string;
	roomId: string;
	participants: CollabParticipant[]; // [{name: hostName, role:"host"}, ...guests {name, role:"guest", readOnly?}]
}

export interface CollabHostAdapterOptions {
	hostName: string;
	onStatusChange?: (status: CollabHostStatus | null) => void;
}

export class CollabHostAdapter {
	#port: CollabSessionPort;
	#opts: CollabHostAdapterOptions;
	#socket: CollabSocket | null = null;
	#link = "";
	#viewLink = "";
	#relayUrl = "";
	#roomId = "";
	#writeToken: Uint8Array | null = null;
	#sessionId = "";
	/** True once the socket first opened; cleared on teardown. Gates `status`. */
	#live = false;
	#unsubscribe?: () => void;
	#busUnsubscribers: (() => void)[] = [];
	#agentsUnsubscribe?: () => void;
	#peers = new Map<number, { name: string; canWrite: boolean }>();
	#uiReqSeq = 0;
	#pendingUi = new Map<
		number,
		{ request: CollabUiRequest; settle(result: CollabGuestUiResult): void }
	>();
	#lastStateJson = "";
	#stateDebounce: Timer | null = null;
	#streamingInterval: Timer | null = null;
	#agentsDebounce: Timer | null = null;
	#stopped = false;

	constructor(port: CollabSessionPort, opts: CollabHostAdapterOptions) {
		this.#port = port;
		this.#opts = opts;
	}

	/** Live status with current participants; `null` when not live. */
	get status(): CollabHostStatus | null {
		if (!this.#live || !this.#socket) return null;
		return {
			state: "live",
			link: this.#link,
			viewLink: this.#viewLink,
			relayUrl: this.#relayUrl,
			roomId: this.#roomId,
			participants: this.participants,
		};
	}

	get isLive(): boolean {
		return this.#live && !this.#stopped && this.#socket !== null;
	}

	/** Number of connected guests that hold a valid write token. */
	get writableGuestCount(): number {
		let count = 0;
		for (const peer of this.#peers.values()) {
			if (peer.canWrite) count++;
		}
		return count;
	}

	/** Host + connected guests (mirrors CollabHost's status-line participant count). */
	get participantCount(): number {
		return this.#peers.size + 1;
	}

	get participants(): CollabParticipant[] {
		const list: CollabParticipant[] = [{ name: this.#opts.hostName, role: "host" }];
		for (const peer of this.#peers.values()) {
			list.push({ name: peer.name, role: "guest", readOnly: peer.canWrite ? undefined : true });
		}
		return list;
	}

	requestGuestUi(
		request: CollabUiRequestDraft,
		signal?: AbortSignal,
	): Promise<CollabGuestUiResult> | null {
		if (!this.#socket || !this.#hasWritablePeers()) return null;
		const reqId = ++this.#uiReqSeq;
		const fullRequest: CollabUiRequest = { ...request, reqId };
		const { promise, resolve } = Promise.withResolvers<CollabGuestUiResult>();
		let settled = false;
		const settle = (result: CollabGuestUiResult): void => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			this.#pendingUi.delete(reqId);
			this.#sendWritablePeers({ t: "ui-request-end", reqId });
			resolve(result);
		};
		const onAbort = (): void => settle({ kind: "unavailable" });
		if (signal?.aborted) return Promise.resolve({ kind: "unavailable" });
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#pendingUi.set(reqId, { request: fullRequest, settle });
		this.#sendWritablePeers({ t: "ui-request", request: fullRequest });
		return promise;
	}

	#hasWritablePeers(): boolean {
		for (const peer of this.#peers.values()) {
			if (peer.canWrite) return true;
		}
		return false;
	}

	#sendWritablePeers(frame: CollabFrame): void {
		const socket = this.#socket;
		if (!socket) return;
		for (const [peerId, peer] of this.#peers) {
			if (peer.canWrite) socket.send(frame, peerId);
		}
	}

	/** Generates room+key+token, connects to the relay; resolves once the socket first opens. Throws on connect failure. */
	async start(relayUrl: string, connectUrl?: string): Promise<void> {
		const rawKey = generateRoomKey();
		const writeToken = generateWriteToken();
		const roomId = generateRoomId();
		this.#writeToken = writeToken;
		this.#relayUrl = relayUrl;
		this.#roomId = roomId;
		this.#link = formatCollabLink(relayUrl, roomId, rawKey, writeToken);
		this.#viewLink = formatCollabLink(relayUrl, roomId, rawKey);
		const parsed = parseCollabLink(this.#link);
		if ("error" in parsed) throw new Error(parsed.error);
		const key = await importRoomKey(rawKey);

		// The relay lives in the same process: connect via the local endpoint
		// (loopback) so a public collabUrl — which join LINKS must advertise —
		// never hairpins the host socket back through the network. The R14
		// host gate requires a loopback peer or a bearer token, and the host
		// adapter authenticates by loopback only.
		const wsUrl =
			connectUrl !== undefined ? `${connectUrl.replace(/\/+$/, "")}/r/${roomId}` : parsed.wsUrl;
		const socket = new CollabSocket({ wsUrl, role: "host", key });
		this.#socket = socket;
		this.#sessionId = this.#port.getSessionId();

		const firstOpen = Promise.withResolvers<void>();
		let opened = false;
		socket.onOpen = () => {
			if (!opened) {
				opened = true;
				firstOpen.resolve();
			}
		};
		socket.onFrame = (frame, fromPeer) => this.#handleFrame(frame, fromPeer);
		socket.onControl = (msg) => {
			if (msg.t === "peer-left") this.#handlePeerLeft(msg.peer);
		};
		socket.onClose = (reason, willReconnect) => {
			if (this.#stopped) return;
			if (!opened) {
				firstOpen.reject(new Error(reason));
				return;
			}
			if (willReconnect) {
				// Transient relay drop: CollabSocket retries with backoff; keep
				// the taps and status as-is (no TUI status line to update).
				console.debug(`collab host relay connection lost (${reason}), reconnecting…`);
			} else {
				void this.#teardown();
				this.#port.emitNotice("warning", `Collab ended: ${reason}`, "collab");
			}
		};
		socket.connect();

		const timeout = setTimeout(
			() => firstOpen.reject(new Error("timed out connecting to relay")),
			CONNECT_TIMEOUT_MS,
		);
		try {
			await firstOpen.promise;
		} catch (err) {
			this.#stopped = true;
			socket.close();
			this.#socket = null;
			throw err;
		} finally {
			clearTimeout(timeout);
		}

		this.#unsubscribe = this.#port.subscribe((event) => {
			if (isWireAgentEvent(event))
				this.#broadcast({ t: "event", event: shrinkForReplication(event) });
			this.#onEventForState(event);
		});
		// Port contract: one subscribeBus call covers BOTH task channels
		// (lifecycle + progress); subscribing per channel would broadcast
		// every bus frame to each guest twice.
		this.#busUnsubscribers.push(
			this.#port.subscribeBus((ch, data) => this.#broadcast({ t: "bus", channel: ch, data })),
		);
		this.#agentsUnsubscribe = this.#port.subscribeAgents(() => this.#scheduleAgentsBroadcast());
		this.#port.onEntryAppended((entry) => {
			if (isWireSessionEntry(entry))
				this.#broadcast({ t: "entry", entry: shrinkForReplication(entry) });
			// Model/thinking/title changes land as entries while idle; refresh
			// guest state promptly (debounce + JSON diff dedupe).
			this.#scheduleStateBroadcast();
		});
		this.#live = true;
		this.#opts.onStatusChange?.(this.status);
	}

	/** Sends {t:"bye",reason} then tears down (unsubscribe, clear taps/timers, settle pending ui, close socket, status → null). */
	async stop(reason: string): Promise<void> {
		if (this.#stopped) return;
		this.#socket?.send({ t: "bye", reason });
		// CollabSocket seals sends on an internal async chain; teardown's
		// socket.close() marks the socket closed and drops still-pending seals,
		// so yield one event-loop turn for the bye to reach the wire first.
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
		await this.#teardown();
	}

	async #teardown(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		this.#live = false;
		this.#restoreEntryAppendedSlot();
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		for (const unsubscribe of this.#busUnsubscribers) unsubscribe();
		this.#busUnsubscribers = [];
		this.#agentsUnsubscribe?.();
		this.#agentsUnsubscribe = undefined;
		clearTimeout(this.#stateDebounce ?? undefined);
		this.#stateDebounce = null;
		clearTimeout(this.#agentsDebounce ?? undefined);
		this.#agentsDebounce = null;
		clearInterval(this.#streamingInterval ?? undefined);
		this.#streamingInterval = null;
		for (const pending of this.#pendingUi.values()) pending.settle({ kind: "unavailable" });
		this.#pendingUi.clear();
		this.#peers.clear();
		this.#socket?.close();
		this.#socket = null;
		this.#opts.onStatusChange?.(null);
	}

	/**
	 * Restore (clear) the port's single onEntryAppended slot. The previous
	 * handler is not readable through the port API; every real wiring
	 * (index.ts, tests) leaves the slot empty, so clearing it equals restoring
	 * it — the adapter's equivalent of CollabHost's
	 * `sessionManager.onEntryAppended = undefined`. A port implementation that
	 * must preserve a handler of its own does the save/restore inside
	 * `onEntryAppended` per the interface contract.
	 */
	#restoreEntryAppendedSlot(): void {
		(this.#port as CollabSessionPort & { onEntryAppended(cb: null): void }).onEntryAppended(null);
	}

	#broadcast(frame: CollabFrame): void {
		if (this.#stopped || !this.#socket) return;
		if (this.#port.getSessionId() !== this.#sessionId) {
			void this.stop("session switched");
			this.#port.emitNotice("warning", "Collab ended: session switched", "collab");
			return;
		}
		this.#socket.send(frame);
	}

	#handleFrame(frame: CollabFrame, fromPeer: number): void {
		switch (frame.t) {
			case "hello":
				this.#handleHello(frame.name, frame.proto, frame.writeToken, fromPeer);
				break;
			case "prompt":
				this.#handlePrompt(frame.text, frame.images, fromPeer);
				break;
			case "abort":
				this.#handleAbort(fromPeer);
				break;
			case "agent-cmd":
				this.#handleAgentCmd(frame.cmd, frame.agentId, frame.text, fromPeer);
				break;
			case "ui-response":
				this.#handleUiResponse(frame.reqId, frame.value, fromPeer);
				break;
			case "fetch-transcript":
				void this.#handleFetchTranscript(frame.reqId, frame.agentId, frame.fromByte, fromPeer);
				break;
			default:
				console.debug("collab host ignoring unexpected frame", { type: frame.t, fromPeer });
		}
	}

	/** Timing-safe write-token check; peers without a valid token are read-only. */
	#verifyWriteToken(token: string | undefined): boolean {
		const expected = this.#writeToken;
		if (!expected || !token) return false;
		const bytes = Buffer.from(token, "base64url");
		return bytes.byteLength === expected.byteLength && timingSafeEqual(bytes, expected);
	}

	/** Reject a mutating frame from a read-only peer with a targeted error. */
	#rejectReadOnly(action: string, fromPeer: number): void {
		this.#socket?.send(
			{ t: "error", message: `${action} is disabled on a read-only link` },
			fromPeer,
		);
	}

	#handleHello(
		name: string,
		proto: number,
		writeToken: string | undefined,
		fromPeer: number,
	): void {
		if (proto !== COLLAB_PROTO) {
			this.#socket?.send(
				{
					t: "error",
					message: `protocol mismatch: host speaks v${COLLAB_PROTO}, guest sent v${proto}`,
				},
				fromPeer,
			);
			return;
		}
		const cleanName = name.trim().slice(0, 64) || `guest-${fromPeer}`;
		const canWrite = this.#verifyWriteToken(writeToken);
		this.#peers.set(fromPeer, { name: cleanName, canWrite });

		// Snapshot and send synchronously: no awaits between snapshot, welcome,
		// and chunk sends, so subsequent broadcast frames (entry/event/state/bus)
		// queue behind the snapshot on the same socket and the guest can't
		// observe a gap between the snapshot fragment and live traffic.
		const snapshot = this.#port.snapshot();
		if (JSON.stringify(snapshot).length > WELCOME_IMAGE_STRIP_THRESHOLD) {
			let stripped = 0;
			for (const entry of snapshot.entries) {
				if (entry.type === "message") stripped += stripImagesFromMessage(entry.message);
			}
			console.info("collab welcome exceeded size threshold; stripped images", { stripped });
		}
		const entries = snapshot.entries.filter(isWireSessionEntry);
		const socket = this.#socket;
		if (!socket) return;
		socket.send(
			{
				t: "welcome",
				proto: COLLAB_PROTO,
				header: snapshot.header,
				state: this.#buildState(),
				agents: this.#snapshotAgents(),
				entryCount: entries.length,
				readOnly: canWrite ? undefined : true,
			},
			fromPeer,
		);
		this.#sendSnapshotChunks(entries, fromPeer);
		if (canWrite) {
			for (const pending of this.#pendingUi.values()) {
				socket.send({ t: "ui-request", request: pending.request }, fromPeer);
			}
		}
		this.#port.emitNotice(
			"info",
			`${cleanName} joined the collab session${canWrite ? "" : " (read-only)"}`,
			"collab",
		);
		this.#opts.onStatusChange?.(this.status);
		this.#scheduleStateBroadcast();
	}

	/**
	 * Slice {@link entries} into byte-bounded `snapshot-chunk` frames targeted
	 * at {@link fromPeer}. Each entry is first run through
	 * {@link shrinkForReplication} so a single oversized tool-result entry
	 * cannot ship as an oversized chunk that trips the relay's per-frame
	 * `maxPayloadLength`. Every batch carries at least one entry, and the last
	 * batch is tagged `final: true` so the guest can finalize the replica. An
	 * empty snapshot still emits one `final` chunk so the guest never blocks
	 * on a missing terminator.
	 */
	#sendSnapshotChunks(entries: (SessionEntry & WireSessionEntry)[], fromPeer: number): void {
		const socket = this.#socket;
		if (!socket) return;
		if (entries.length === 0) {
			socket.send({ t: "snapshot-chunk", entries: [], final: true }, fromPeer);
			return;
		}
		let i = 0;
		while (i < entries.length) {
			const batch: (SessionEntry & WireSessionEntry)[] = [];
			let batchBytes = 0;
			while (i < entries.length) {
				const entry = entries[i];
				if (!entry) break;
				const shrunk = shrinkForReplication(entry);
				const entryBytes = JSON.stringify(shrunk).length;
				if (batch.length > 0 && batchBytes + entryBytes > SNAPSHOT_CHUNK_BYTES) break;
				batch.push(shrunk);
				batchBytes += entryBytes;
				i++;
			}
			socket.send({ t: "snapshot-chunk", entries: batch, final: i >= entries.length }, fromPeer);
		}
	}

	#handleUiResponse(reqId: number, value: CollabUiResponseValue, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("responding to ask", fromPeer);
			return;
		}
		this.#pendingUi.get(reqId)?.settle({ kind: "answered", value });
	}

	#handlePrompt(text: string, images: ImageContent[] | undefined, fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("prompting", fromPeer);
			return;
		}
		this.#port.promptFromGuest(text, images, peer.name).catch((err) => {
			console.warn("collab guest prompt failed", { error: String(err) });
			this.#socket?.send({ t: "error", message: `prompt failed: ${String(err)}` }, fromPeer);
		});
	}

	#handleAbort(fromPeer: number): void {
		const peer = this.#peers.get(fromPeer);
		if (!peer?.canWrite) {
			this.#rejectReadOnly("interrupting", fromPeer);
			return;
		}
		const name = peer.name;
		void this.#port
			.abort()
			.then(() => this.#port.emitNotice("info", `${name} interrupted`, "collab"))
			.catch((err) => console.warn("collab guest abort failed", { error: String(err) }));
	}

	#handlePeerLeft(peer: number): void {
		const name = this.#peers.get(peer)?.name;
		this.#peers.delete(peer);
		if (name) this.#port.emitNotice("info", `${name} left the collab session`, "collab");
		this.#opts.onStatusChange?.(this.status);
		this.#scheduleStateBroadcast();
	}

	#buildState(): CollabSessionState {
		return {
			isStreaming: this.#port.isStreaming(),
			isAborting: this.#port.isAborting(),
			queuedMessageCount: this.#port.queuedMessageCount(),
			sessionName: this.#port.getSessionName(),
			cwd: this.#port.getCwd(),
			model: this.#port.getModel(),
			thinkingLevel: this.#port.getThinkingLevel(),
			// The wire shape (SessionState.contextUsage) allows nulls; the local
			// CollabSessionState intersection narrows to non-null numbers, so the
			// contract's null fallback needs a cast to the session-side type.
			contextUsage: (this.#port.getContextUsage() ?? {
				tokens: null,
				contextWindow: null,
				percent: null,
			}) as CollabSessionState["contextUsage"],
			participants: this.participants,
		};
	}

	#onEventForState(event: AgentSessionEvent): void {
		if (!STATE_TRIGGER_EVENTS[event.type]) return;
		this.#scheduleStateBroadcast();
		if (event.type === "agent_start" && !this.#streamingInterval) {
			this.#streamingInterval = setInterval(
				() => this.#scheduleStateBroadcast(),
				STREAMING_STATE_INTERVAL_MS,
			);
		} else if (event.type === "agent_end" && this.#streamingInterval) {
			clearInterval(this.#streamingInterval);
			this.#streamingInterval = null;
		}
	}

	#snapshotAgents(): AgentSnapshot[] {
		return this.#port
			.listAgents()
			.filter(
				(ref): ref is CollabAgentRef & { kind: "main" | "sub" } =>
					ref.kind === "main" || ref.kind === "sub",
			)
			.map((ref) => ({
				id: ref.id,
				displayName: ref.displayName,
				kind: ref.kind,
				parentId: ref.parentId,
				status: ref.status,
				hasSessionFile: ref.hasSessionFile,
				createdAt: ref.createdAt,
				lastActivity: ref.lastActivity,
			}));
	}

	#scheduleAgentsBroadcast(): void {
		if (this.#stopped || this.#agentsDebounce) return;
		this.#agentsDebounce = setTimeout(() => {
			this.#agentsDebounce = null;
			this.#broadcast({ t: "agents", agents: this.#snapshotAgents() });
		}, AGENTS_DEBOUNCE_MS);
	}

	#handleAgentCmd(
		cmd: "chat" | "kill" | "revive",
		agentId: string,
		text: string | undefined,
		fromPeer: number,
	): void {
		if (!this.#peers.get(fromPeer)?.canWrite) {
			this.#rejectReadOnly("agent control", fromPeer);
			return;
		}
		// Advisor refs are excluded from port snapshots (CollabAgentRef.kind has
		// no `advisor`), but reject control by id defensively — mirrors
		// CollabHost's guard: a stale/malicious client must never chat/kill/
		// revive a read-only advisor transcript.
		const ref = this.#port.listAgents().find((a) => a.id === agentId);
		if (ref && ref.kind !== "main" && ref.kind !== "sub") {
			this.#socket?.send(
				{ t: "error", message: `${agentId}: advisor transcripts are read-only` },
				fromPeer,
			);
			return;
		}
		this.#port.agentCmd(cmd, agentId, text).catch((err) => {
			console.warn("collab agent-cmd failed", { cmd, agentId, error: String(err) });
			this.#socket?.send({ t: "error", message: `agent ${agentId}: ${String(err)}` }, fromPeer);
		});
	}

	/** Incremental transcript read mirroring CollabHost's readFileIncremental contract. */
	async #handleFetchTranscript(
		reqId: number,
		agentId: string,
		fromByte: number,
		fromPeer: number,
	): Promise<void> {
		const reply = (text: string, newSize: number, error?: string) =>
			this.#socket?.send({ t: "transcript", reqId, text, newSize, error }, fromPeer);
		const file = this.#port.resolveTranscriptFile(agentId);
		if (!file) {
			reply("", fromByte, "no transcript available");
			return;
		}
		try {
			const stat = await fs.stat(file);
			if (stat.size <= fromByte) {
				reply("", stat.size);
				return;
			}
			const want = Math.min(stat.size - fromByte, TRANSCRIPT_READ_CAP);
			const handle = await fs.open(file, "r");
			let bytesRead: number;
			const buf = Buffer.allocUnsafe(want);
			try {
				({ bytesRead } = await handle.read(buf, 0, want, fromByte));
			} finally {
				await handle.close();
			}
			let slice = buf.subarray(0, bytesRead);
			const reachedEof = fromByte + bytesRead >= stat.size;
			if (!reachedEof) {
				// Trim to the last complete JSONL line so no line or UTF-8 char is split.
				const lastNewline = slice.lastIndexOf(0x0a);
				if (lastNewline < 0) {
					reply("", fromByte, TRANSCRIPT_ENTRY_TOO_LARGE_ERROR);
					return;
				}
				slice = slice.subarray(0, lastNewline + 1);
			}
			reply(slice.toString("utf-8"), reachedEof ? stat.size : fromByte + slice.byteLength);
		} catch (err) {
			console.debug("collab transcript read failed", { agentId, error: String(err) });
			reply("", fromByte, String(err));
		}
	}

	#scheduleStateBroadcast(): void {
		if (this.#stopped || this.#stateDebounce) return;
		this.#stateDebounce = setTimeout(() => {
			this.#stateDebounce = null;
			const state = this.#buildState();
			const json = JSON.stringify(state);
			if (json === this.#lastStateJson) return;
			this.#lastStateJson = json;
			this.#broadcast({ t: "state", state });
		}, STATE_DEBOUNCE_MS);
	}
}
