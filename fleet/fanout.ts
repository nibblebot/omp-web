/**
 * Fan-out prompt correlation (R9).
 *
 * promptEntry: wake the daemon if it is not ready+connected (spawned →
 * supervisor.respawn with --resume, otherwise connector.connect), await
 * ready, retain the socket for the whole turn, send a fire-and-forget
 * `{type:"call", method:"prompt"}` and correlate the daemon's frames:
 *
 *  - resolve on an `agent_end` event; the result text is the LAST assistant
 *    message's joined text parts (from `message_end` events seen meanwhile),
 *    and usage is picked best-effort from the agent_end payload;
 *  - reject on `{type:"error"}` frames, on a `call_result` for our id with
 *    ok:false, on any event whose type contains "abort", or on the waitMs
 *    timeout (default 120s → error "timeout").
 *
 * fanOut runs promptEntry over the selected entries with Promise.all; the
 * result array preserves entry order across mixed ok/error outcomes.
 */

import { randomUUID } from "node:crypto";
import type { ClientCommand, ServerFrame } from "../src/protocol";
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

export async function promptEntry(
	deps: FanoutDeps,
	entry: RegistryEntry,
	text: string,
	waitMs?: number,
): Promise<PromptResult> {
	const daemonId = entry.daemonId;
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
 * Subscribe to daemon frames and settle on agent_end / error / abort /
 * timeout. Returns the result promise plus a cancel() that detaches without
 * settling (used when send() fails after subscribing).
 */
function correlate(
	deps: FanoutDeps,
	daemonId: string,
	callId: string,
	waitMs?: number,
): { promise: Promise<PromptResult>; cancel: () => void } {
	const { promise, resolve } = Promise.withResolvers<PromptResult>();
	let settled = false;
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
		if (frame.type === "error") {
			settle({ daemonId, ok: false, error: frame.error });
			return;
		}
		if (frame.type === "call_result" && frame.id === callId && frame.ok === false) {
			settle({ daemonId, ok: false, error: frame.error ?? "prompt call failed" });
			return;
		}
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
