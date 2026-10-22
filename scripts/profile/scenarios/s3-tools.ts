/**
 * S3: tool-heavy. One session runs real `bash` tool calls with large outputs,
 * back to back, while a browser client watches (tool events, bash chunks).
 */
import { ProfileClient } from "../client";
import { toolTurn } from "../fake-model/directives";
import { metric, type MetricReading } from "../types";
import {
	dropNotes,
	frameBreakdown,
	freshSession,
	resyncMetrics,
	idleRtt,
	rttMetrics,
	streamMetrics,
	TOOL_CALLS_PER_TURN,
	TOOL_HISTORY_BUDGET_BYTES,
	TOOL_OUTPUT_BYTES,
	TOOL_TURNS_PER_SESSION,
} from "./common";
import type { RepOutcome, Scenario } from "./env";

const PROBE_INTERVAL_MS = 250;
const CALLS_PER_TURN = TOOL_CALLS_PER_TURN;
const OUTPUT_BYTES = TOOL_OUTPUT_BYTES;
const TURNS_PER_SESSION = TOOL_TURNS_PER_SESSION;
const HISTORY_BUDGET_BYTES = TOOL_HISTORY_BUDGET_BYTES;

export const s3Tools: Scenario = {
	id: "s3-tools",
	title: "S3 tool-heavy",
	description:
		`One session (pin slot 4, route s3) runs turns of ${CALLS_PER_TURN} sequential real bash calls, each printing ` +
		`${OUTPUT_BYTES} bytes, repeated until the rep window elapses. The SDK truncates very large tool output before it ` +
		"reaches the wire, so wire bytes are the measured truth (H1 and H2 byte metrics). A synthetic client is attached; " +
		"it probes command RTT every 250 ms. Tool subprocesses count toward the session's CPU (its process tree). " +
		"The session is replaced (newSession, a history resync) every few turns so its history stays under 3 MiB: past about 4 MiB the edge drops attaches and re-primes, " +
		"and past about 8 MiB a dropped stream can never re-attach (see s1-history-large; measured on the previous SSE transport, to be re-measured on /ws). The client behaves like the web client on a dropped socket " +
		"(redial with `after`, re-attach) and counts it: h1.drops, h1.recovery.*.",
	async start(env) {
		const repo = await env.newRepo("s3");
		const handle = await env.stack.addSession({ label: "s3", slot: 2 }, repo);
		const client = await ProfileClient.connect(env.adapter, env.stack.baseUrl);
		await client.attach(handle.daemonId, handle.label);
		return {
			async rep(): Promise<RepOutcome> {
				const notes: string[] = [];
				const affinity = await env.verify([handle]);
				const metrics: Record<string, MetricReading> = {};
				await freshSession(client);
				const idle = await idleRtt(client, 10);
				Object.assign(metrics, rttMetrics("rtt.idle", idle.rttMs, idle.failures));
				client.resetCounters();
				const window = await env.window([client]);
				const probe = client.startRttProbe("getQueuedMessages", PROBE_INTERVAL_MS);
				const startedAt = Date.now();
				let turns = 0;
				let sessionTurns = 0;
				let sessions = 1;
				do {
					if (sessionTurns >= TURNS_PER_SESSION) {
						await freshSession(client);
						sessionTurns = 0;
						sessions++;
					}
					await client.prompt(
						toolTurn({ route: handle.label, calls: CALLS_PER_TURN, outputBytes: OUTPUT_BYTES }),
						120_000,
					);
					turns++;
					sessionTurns++;
				} while (Date.now() - startedAt < env.durationMs);
				const probed = await probe.stop();
				const closed = await window.close();
				Object.assign(metrics, closed.metrics);
				dropNotes(closed.drops, notes);
				Object.assign(metrics, rttMetrics("rtt.load", probed.rttMs, probed.failures));
				Object.assign(metrics, await streamMetrics(env, client, notes));
				Object.assign(metrics, resyncMetrics(client.byType, notes));
				metrics["tool.turns"] = metric(turns, "count", "info");
				metrics["tool.sessions"] = metric(sessions, "count", "info");
				notes.push(
					`session replaced (newSession) every ${TURNS_PER_SESSION} turns to keep its history under ${HISTORY_BUDGET_BYTES / (1024 * 1024)} MiB of tool output (${sessions} session(s) this rep)`,
				);
				metrics["tool.calls"] = metric(turns * CALLS_PER_TURN, "count", "info");
				notes.push(frameBreakdown(client.byType));
				return { metrics, notes, affinity };
			},
			async close() {
				await client.close();
				await env.stack.removeSession(handle);
			},
		};
	},
};
