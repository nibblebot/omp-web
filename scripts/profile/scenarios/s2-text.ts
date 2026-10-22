/**
 * S2: high-rate text deltas. One session streams a long text block at a fixed
 * delta rate while a browser client watches it and probes command RTT.
 */
import { ProfileClient } from "../client";
import { textTurn } from "../fake-model/directives";
import { metric, type MetricReading } from "../types";
import {
	dropNotes,
	frameBreakdown,
	resyncMetrics,
	idleRtt,
	reconnectMetrics,
	rttMetrics,
	streamMetrics,
} from "./common";
import type { RepOutcome, Scenario } from "./env";

const DELTAS_PER_SEC = 400;
const CHUNK_CHARS = 8;
const PROBE_INTERVAL_MS = 200;
const IDLE_RTT_CALLS = 20;

export const s2Text: Scenario = {
	id: "s2-text",
	title: "S2 high-rate text deltas",
	description:
		`One session (pin slot 2, route s2) streams one text block at ${DELTAS_PER_SEC} deltas/s ` +
		`(${CHUNK_CHARS} chars each) for the rep window. A synthetic client is attached to it (H1 = frames the ` +
		"client receives) and fires a read-only command every 200 ms to measure RTT under load; idle RTT is " +
		"sampled first. Stream latency joins model send time to client receive time per delta. After the window, " +
		"a second short turn is interrupted by a browser-socket drop and a redial with `after` plus re-attach " +
		"(reconnect.* metrics: the reconnect cost mid-stream, replay and re-priming included; the pair itself is not dropped).",
	async start(env) {
		const repo = await env.newRepo("s2");
		const handle = await env.stack.addSession({ label: "s2", slot: 1 }, repo);
		const client = await ProfileClient.connect(env.adapter, env.stack.baseUrl);
		await client.attach(handle.daemonId, handle.label);
		return {
			async rep(): Promise<RepOutcome> {
				const notes: string[] = [];
				const affinity = await env.verify([handle]);
				const metrics: Record<string, MetricReading> = {};
				const idle = await idleRtt(client, IDLE_RTT_CALLS);
				Object.assign(metrics, rttMetrics("rtt.idle", idle.rttMs, idle.failures));

				client.resetCounters();
				const chars = Math.round((env.durationMs / 1000) * DELTAS_PER_SEC * CHUNK_CHARS);
				const window = await env.window([client]);
				const probe = client.startRttProbe("getQueuedMessages", PROBE_INTERVAL_MS);
				const turn = await client.prompt(
					textTurn({
						route: handle.label,
						chars,
						chunkChars: CHUNK_CHARS,
						deltasPerSec: DELTAS_PER_SEC,
					}),
					env.durationMs + 60_000,
				);
				const probed = await probe.stop();
				const closed = await window.close();
				Object.assign(metrics, closed.metrics);
				dropNotes(closed.drops, notes);
				Object.assign(metrics, rttMetrics("rtt.load", probed.rttMs, probed.failures));
				Object.assign(metrics, await streamMetrics(env, client, notes));
				Object.assign(metrics, resyncMetrics(client.byType, notes));
				metrics["turn.ms"] = metric(turn.turnMs, "ms", "info", "clock-monotonic-ffi");
				if (turn.firstDeltaMs !== undefined) {
					metrics["turn.first-delta.ms"] = metric(
						turn.firstDeltaMs,
						"ms",
						"lower",
						"clock-monotonic-ffi",
					);
				}
				notes.push(frameBreakdown(client.byType));
				notes.push(
					`${chars} text chars streamed in ${(turn.turnMs / 1000).toFixed(1)} s (target ${DELTAS_PER_SEC} deltas/s)`,
				);

				// Reconnect mid-stream. Latency of this phase is not joined (re-attach resets the ordinal count).
				client.resetCounters();
				const interrupted = client.prompt(
					textTurn({
						route: handle.label,
						chars: 4000,
						chunkChars: CHUNK_CHARS,
						deltasPerSec: DELTAS_PER_SEC,
					}),
					60_000,
				);
				interrupted.catch(() => undefined);
				await Bun.sleep(400);
				Object.assign(
					metrics,
					reconnectMetrics(await client.reconnect(handle.daemonId, handle.label)),
				);
				await interrupted;
				client.resetCounters();
				return { metrics, notes, affinity };
			},
			async close() {
				await client.close();
				await env.stack.removeSession(handle);
			},
		};
	},
};
