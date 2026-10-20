/**
 * Fan-out prompt correlation (R9).
 *
 * promptEntry: wake the session if its callback pair is down (the shared
 * SessionWaker: a stuck reconnecting/ready row is respawned after the redial
 * grace; clone → lifecycle ensure), wait for the pair, send a fire-and-forget
 * `{type:"call", method:"prompt"}` over the pair's control stream, and
 * correlate the daemon's frames:
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
 * `call_result` for our call id gates acceptance; before it arrives every
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
import { CALLBACK_CONTROL_STREAM_ID } from "#lib/wire/callback-protocol";
import type { ClientCommand, ServerFrame } from "#lib/wire/protocol";
import type { Registry, RegistryEntry } from "./registry";
import type { SessionWaker } from "./session-waker";

export interface PromptResult {
	daemonId: string;
	ok: boolean;
	text?: string;
	usage?: unknown;
	error?: string;
}

/**
 * Minimal transport/lifecycle surfaces the fan-out needs (structural
 * conformance: the server wires the real DaemonTransportRegistry and
 * WorkspaceLifecycle; fan-out never imports them to avoid a cycle).
 */
export interface FanoutTransport {
	pairStatus(workspaceId: string): { paired: boolean };
	onPairChange(workspaceId: string, cb: (status: { paired: boolean }) => void): () => void;
	sendToDaemon(
		workspaceId: string,
		draft: { streamId: string; kind: "command"; payload: unknown },
	): Promise<unknown>;
	onDaemonEnvelope(
		workspaceId: string,
		cb: (envelope: { kind: string; streamId: string; payload: unknown }) => void,
	): () => void;
}

export interface FanoutDeps {
	registry: Registry;
	/** Callback transport: every session's pair carries prompts and answers. */
	transport?: FanoutTransport;
	/** Session wake: brings the pair up before a prompt (clones included). */
	waker: SessionWaker;
}

const DEFAULT_WAIT_MS = 120_000;

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
		const current = deps.registry.get(daemonId) ?? entry;
		return await promptSession(deps, current, text, waitMs);
	};
	// Run only after the previous turn for this daemon fully settles; a
	// rejected predecessor must not block the queue (promptEntry resolves
	// normally in practice, but a stray throw would otherwise stall it).
	const turn = previous.then(run, run);
	const tail = turn.catch(() => {});
	promptQueues.set(daemonId, tail);
	void tail.then(() => {
		if (promptQueues.get(daemonId) === tail) promptQueues.delete(daemonId);
	});
	return turn;
}

/**
 * Prompt one session over its callback pair: wake it when the pair is down,
 * then send kind:"command" on the transport control stream and correlate the
 * frames the daemon mirrors there. No offline queue and no blind
 * retry: a missing transport or an unpairable session answers a typed
 * failure immediately.
 */
async function promptSession(
	deps: FanoutDeps,
	entry: RegistryEntry,
	text: string,
	waitMs?: number,
): Promise<PromptResult> {
	const daemonId = entry.daemonId;
	const transport = deps.transport;
	if (!transport) {
		return { daemonId, ok: false, error: "prompt is unavailable: no callback transport" };
	}
	try {
		await deps.waker.wake(entry);
		await deps.waker.waitForPair(daemonId);
	} catch (err) {
		return { daemonId, ok: false, error: (err as Error).message };
	}
	const id = randomUUID();
	const cmd: ClientCommand = { type: "call", id, method: "prompt", args: [text] };
	const correlation = correlate(daemonId, id, waitMs, (cb) =>
		transport.onDaemonEnvelope(daemonId, (envelope) => {
			if (envelope.kind !== "frame" || envelope.streamId !== CALLBACK_CONTROL_STREAM_ID) return;
			const payload = envelope.payload;
			if (typeof payload === "object" && payload !== null) cb(payload as ServerFrame);
		}),
	);
	try {
		await transport.sendToDaemon(daemonId, {
			streamId: CALLBACK_CONTROL_STREAM_ID,
			kind: "command",
			payload: cmd,
		});
	} catch {
		correlation.cancel();
		return { daemonId, ok: false, error: "daemon not connected" };
	}
	return await correlation.promise;
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
 * Subscribe to the session's control-stream frames and settle on OUR turn's
 * agent_end / abort / timeout. Returns the result promise plus a cancel()
 * that detaches without settling (used when send() fails after subscribing).
 *
 * The control stream carries every concurrent turn on the session, so
 * correlation is gated on the `call_result` for our call id: until it
 * confirms acceptance (ok:true) or rejection (ok:false), all turn frames are
 * ignored; a browser-driven turn's agent_end or abort can never settle our
 * promise. Broadcast `{type:"error"}` frames carry no call id and are never
 * fatal; our own call failures arrive as id-matched `call_result{ok:false}`.
 */
function correlate(
	daemonId: string,
	callId: string,
	waitMs: number | undefined,
	subscribe: (cb: (frame: ServerFrame) => void) => () => void,
): { promise: Promise<PromptResult>; cancel: () => void } {
	const { promise, resolve } = Promise.withResolvers<PromptResult>();
	let settled = false;
	let accepted = false;
	let lastText: string | undefined;
	let usage: unknown;
	let unsubscribe: () => void = () => {};
	const timeoutMs = waitMs ?? DEFAULT_WAIT_MS;
	const timer = setTimeout(() => settle({ daemonId, ok: false, error: "timeout" }), timeoutMs);
	unsubscribe = subscribe(handleFrame);
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
		// concurrent turn, never fatal for us. Our call's failures arrive as
		// the id-matched call_result ok:false handled above.
		if (frame.type === "error") return;
		if (frame.type !== "event") return;
		// Wire events are external data; narrow before reading fields.
		const ev: unknown = frame.event;
		if (typeof ev !== "object" || ev === null || !("type" in ev) || typeof ev.type !== "string")
			return;
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
