/**
 * Fan-out prompt correlation (R9).
 *
 * promptEntry: wake the daemon if it is not ready+connected (spawned →
 * supervisor.respawn with --resume, otherwise connector.connect), await
 * ready, retain the socket for the whole turn, send a fire-and-forget
 * `{type:"call", method:"prompt"}` and correlate the daemon's frames:
 *
 *  - resolve on the `agent_end` event of OUR turn; the result text is the
 *    LAST assistant message's joined text parts (from `message_end` events
 *    seen meanwhile), and usage is picked best-effort from the agent_end
 *    payload;
 *  - reject on a `call_result` for our id with ok:false, on any event whose
 *    type contains "abort" once our prompt is accepted, or on the waitMs
 *    timeout (default 120s → error "timeout").
 *
 * Correlation is scoped to OUR call (audit #21): the control stream carries
 * every turn on the daemon, so `agent_end`/`message_end`/abort events and
 * broadcast `{type:"error"}` frames from concurrent turns (browser-driven
 * prompts, other fan-outs) must never settle this promise. Only the
 * `call_result` for our call id gates acceptance — before it arrives every
 * turn frame is ignored, and broadcast error frames (which carry no call id)
 * are never fatal. Per-call failures arrive as id-matched
 * `call_result{ok:false}`; a prompt the daemon never answers settles on the
 * timeout.
 *
 * Fan-out prompts are also serialized per daemon (a per-daemonId promise
 * queue): concurrent fan-outs to one daemon can never interleave turns, so
 * each fan-out's own `call_result` → events → `agent_end` sequence is
 * contiguous on the stream.
 *
 * fanOut runs promptEntry over the selected entries with Promise.all; the
 * result array preserves entry order across mixed ok/error outcomes.
 */

import { randomUUID } from "node:crypto";
import type { ClientCommand, ServerFrame } from "../shared/protocol";
import type { Registry, RegistryEntry } from "./registry";
import type { DaemonConnector } from "./connector";
import type { SpawnSupervisor } from "./supervisor";

export interface PromptResult {
	daemonId: string;
	ok: boolean;
	text?: string;
	usage?: unknown;
	error?: string;
}

export interface FanoutDeps {
	registry: Registry;
	connector: DaemonConnector;
	supervisor: SpawnSupervisor;
}

const DEFAULT_WAIT_MS = 120_000;
const DEFAULT_WAIT_READY_MS = 60_000;

/**
 * Per-daemon serialization (audit #21): one fan-out prompt turn in flight per
 * daemon. Each promptEntry chains its whole wake → send → correlate run
 * behind the previous one for the same daemonId, so two concurrent fan-outs
 * to one daemon cannot interleave turns on the control stream. Entries are
 * dropped once idle so the map stays bounded by live/queued turns.
 */
const promptQueues = new Map<string, Promise<unknown>>();

export async function promptEntry(
	deps: FanoutDeps,
	entry: RegistryEntry,
	text: string,
	waitMs?: number,
): Promise<PromptResult> {
	const daemonId = entry.daemonId;
	const previous = promptQueues.get(daemonId) ?? Promise.resolve();
	const run = async (): Promise<PromptResult> => {
		deps.connector.retain(daemonId);
		try {
			const current = deps.registry.get(daemonId) ?? entry;
			try {
				// Wake on demand. A spawned entry that is asleep/error/reconnecting
				// is relaunched (--resume); anything whose socket is merely gone
				// behind a stale "ready" status (idle-drop) needs only a redial —
				// far cheaper than killing a healthy child with a respawn.
				if (current.mode === "spawned" && current.status !== "ready") {
					await deps.supervisor.respawn(current);
					await deps.connector.waitReady(daemonId, DEFAULT_WAIT_READY_MS);
				} else if (!deps.connector.isConnected(daemonId)) {
					deps.connector.connect(daemonId);
					await deps.connector.waitReady(daemonId, DEFAULT_WAIT_READY_MS);
				}
			} catch (err) {
				return { daemonId, ok: false, error: (err as Error).message };
			}
			const id = randomUUID();
			const cmd: ClientCommand = { type: "call", id, method: "prompt", args: [text] };
			// Subscribe BEFORE send: a fast daemon's answer frames must never
			// arrive to find no listener (correlate-after-send could miss them and
			// run to timeout despite a completed turn).
			const correlation = correlate(deps, daemonId, id, waitMs);
			if (!deps.connector.send(daemonId, cmd)) {
				correlation.cancel();
				return { daemonId, ok: false, error: "daemon not connected" };
			}
			return await correlation.promise;
		} finally {
			deps.connector.release(daemonId);
		}
	};
	// Run only after the previous turn for this daemon fully settles; a
	// rejected predecessor must not block the queue (promptEntry resolves
	// normally in practice, but a stray throw would otherwise wedge it).
	const turn = previous.then(run, run);
	const tail = turn.catch(() => {});
	promptQueues.set(daemonId, tail);
	void tail.then(() => {
		if (promptQueues.get(daemonId) === tail) promptQueues.delete(daemonId);
	});
	return turn;
}

export async function fanOut(
	deps: FanoutDeps,
	entries: RegistryEntry[],
	text: string,
	waitMs?: number,
): Promise<PromptResult[]> {
	// Promise.all preserves array order across mixed ok/error outcomes.
	return Promise.all(entries.map((entry) => promptEntry(deps, entry, text, waitMs)));
}

/**
 * Subscribe to daemon frames and settle on OUR turn's agent_end / abort /
 * timeout. Returns the result promise plus a cancel() that detaches without
 * settling (used when send() fails after subscribing).
 *
 * The control stream carries every concurrent turn on the daemon, so
 * correlation is gated on the `call_result` for our call id: until it
 * confirms acceptance (ok:true) or rejection (ok:false), all turn frames are
 * ignored — a browser-driven turn's agent_end or abort can never settle our
 * promise. Broadcast `{type:"error"}` frames carry no call id and are never
 * fatal; our own call failures arrive as id-matched `call_result{ok:false}`.
 */
function correlate(
	deps: FanoutDeps,
	daemonId: string,
	callId: string,
	waitMs?: number,
): { promise: Promise<PromptResult>; cancel: () => void } {
	const { promise, resolve } = Promise.withResolvers<PromptResult>();
	let settled = false;
	let accepted = false;
	let lastText: string | undefined;
	let usage: unknown;
	const timeoutMs = waitMs ?? DEFAULT_WAIT_MS;
	const timer = setTimeout(() => settle({ daemonId, ok: false, error: "timeout" }), timeoutMs);
	const unsubscribe = deps.connector.onFrame(daemonId, (frame) => {
		if (settled) return;
		handleFrame(frame);
	});
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe();
	};

	function settle(result: PromptResult): void {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		unsubscribe();
		resolve(result);
	}

	function handleFrame(frame: ServerFrame): void {
		// Our call's acceptance verdict gates everything that follows.
		if (frame.type === "call_result" && frame.id === callId) {
			if (frame.ok === false) {
				settle({ daemonId, ok: false, error: frame.error ?? "prompt call failed" });
				return;
			}
			accepted = true;
			return;
		}
		// Frames from other concurrent turns predate our acceptance; ignore.
		if (!accepted) return;
		// Broadcast error frames carry no call id and may belong to any
		// concurrent turn — never fatal for us. Our call's failures arrive as
		// the id-matched call_result ok:false handled above.
		if (frame.type === "error") return;
		if (frame.type !== "event") return;
		// Wire events are external data; narrow before reading fields.
		const ev: unknown = frame.event;
		if (typeof ev !== "object" || ev === null || !("type" in ev) || typeof ev.type !== "string") return;
		if (ev.type.includes("abort")) {
			settle({ daemonId, ok: false, error: "aborted" });
			return;
		}
		if (ev.type === "message_end" && "message" in ev) {
			const message = ev.message;
			if (
				typeof message === "object" &&
				message !== null &&
				"role" in message &&
				message.role === "assistant" &&
				"content" in message &&
				Array.isArray(message.content)
			) {
				const joined = message.content
					.filter(
						(part): part is { type: "text"; text: string } =>
							typeof part === "object" &&
							part !== null &&
							"type" in part &&
							part.type === "text" &&
							"text" in part &&
							typeof part.text === "string",
					)
					.map((part) => part.text)
					.join("");
				if (joined) lastText = joined; // keep the LAST assistant message's joined text
			}
			return;
		}
		if (ev.type === "agent_end") {
			if ("usage" in ev) usage = ev.usage;
			const result: PromptResult = { daemonId, ok: true };
			if (lastText !== undefined) result.text = lastText;
			if (usage !== undefined) result.usage = usage;
			settle(result);
		}
	}

	return { promise, cancel };
}
