/**
 * Liveness check: one real session, one short text turn, one synthetic client.
 * Fails (throws `LivenessError`, the runner exits non-zero) when no frames
 * reach the client, the turn produces no text delta, or the session never goes
 * idle. Not timing-based: the deadline only bounds waiting for an event.
 */
import { ProfileClient } from "../client";
import { textTurn } from "../fake-model/directives";
import type { RunEnv } from "./env";

export class LivenessError extends Error {}

export interface LivenessReport {
	frames: number;
	textDeltas: number;
	turnMs: number;
	idle: true;
}

const DEADLINE_MS = 20_000;

export async function checkLiveness(env: RunEnv): Promise<LivenessReport> {
	const repo = await env.newRepo("liveness");
	const handle = await env.stack.addSession({ label: "s2", slot: 1 }, repo);
	const client = await ProfileClient.connect(env.adapter, env.stack.baseUrl);
	try {
		await client.attach(handle.daemonId, handle.label, DEADLINE_MS);
		if (client.frames === 0) throw new LivenessError("no frames reached the client after attach");
		let textDeltas = 0;
		const off = client.onFrame((r) => {
			if (r.frame.type !== "event") return;
			const event = r.frame.event;
			if (typeof event !== "object" || event === null || !("assistantMessageEvent" in event))
				return;
			const inner = event.assistantMessageEvent;
			if (
				typeof inner === "object" &&
				inner !== null &&
				"type" in inner &&
				inner.type === "text_delta"
			) {
				textDeltas++;
			}
		});
		let turnMs: number;
		try {
			const idle = client.waitFrame(
				(r) =>
					r.frame.type === "state" &&
					typeof r.frame.state === "object" &&
					r.frame.state !== null &&
					"isStreaming" in r.frame.state &&
					r.frame.state.isStreaming === false,
				DEADLINE_MS,
				"an idle state frame (isStreaming false) after the turn",
			);
			idle.catch(() => undefined);
			const turn = await client.prompt(
				textTurn({ route: handle.label, chars: 480, chunkChars: 8, deltasPerSec: 60 }),
				DEADLINE_MS,
			);
			turnMs = turn.turnMs;
			await idle;
		} catch (err) {
			throw new LivenessError(
				`session never idled: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			off();
		}
		if (textDeltas === 0)
			throw new LivenessError("turn completed but no text delta reached the client");
		return { frames: client.frames, textDeltas, turnMs, idle: true };
	} finally {
		await client.close();
		await env.stack.removeSession(handle);
	}
}
