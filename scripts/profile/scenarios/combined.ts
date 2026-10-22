/**
 * Combined: the four session shapes at once on one fleet, one browser.
 */
import { join } from "node:path";
import { ProfileClient } from "../client";
import { idleTurn, subagentTurn, textTurn, toolTurn } from "../fake-model/directives";
import { SUB_THRESHOLD_HISTORY, ensureHistoryFixture, materializeHistory } from "../fixture";
import { metric, type MetricReading } from "../types";
import {
	dropNotes,
	frameBreakdown,
	resyncMetrics,
	idleRtt,
	reconnectMetrics,
	rttMetrics,
	freshSession,
	streamMetrics,
	TOOL_CALLS_PER_TURN,
	TOOL_HISTORY_BUDGET_BYTES,
	TOOL_OUTPUT_BYTES,
	TOOL_TURNS_PER_SESSION,
} from "./common";
import type { RepOutcome, RunEnv, Scenario } from "./env";

const DELTAS_PER_SEC = 400;
const CHUNK_CHARS = 8;
const PROBE_INTERVAL_MS = 200;

interface PromptAnswer {
	daemonId: string;
	ok: boolean;
	error?: string;
}

/** Drive a session with no browser attached through the control API until `stopAt`. */
async function ctlLoop(
	env: RunEnv,
	daemonId: string,
	stopAt: number,
	prompt: () => string,
	failures: string[],
	pauseMs: number,
	beforeTurn?: (turn: number) => Promise<void>,
): Promise<number> {
	let turns = 0;
	do {
		await beforeTurn?.(turns);
		const answers = await env.stack.ctl<PromptAnswer[]>("POST", "/ctl/prompt", {
			selector: daemonId,
			text: prompt(),
			waitMs: 120_000,
		});
		for (const a of answers) if (!a.ok) failures.push(`${a.daemonId}: ${a.error ?? "failed"}`);
		turns++;
		if (pauseMs > 0) await Bun.sleep(pauseMs);
	} while (Date.now() < stopAt);
	return turns;
}

export const combined: Scenario = {
	id: "combined",
	title: "Combined: four sessions, one browser",
	description:
		"All four shapes run on one fleet at the same time, each on its own pinned core: s1 holds the large-history session " +
		"(resumed from the cached fixture, driven with idle turns), s2 streams high-rate text, s3 runs tool-heavy turns, s4 fans out " +
		"subagents. The ONE browser client attaches to s2 only: it receives s2's full stream plus the fleet-global frames " +
		"(roster/daemon_activity) the other sessions cause, and probes command RTT; stream latency is s2's. The other sessions are " +
		"driven through POST /ctl/prompt and observed externally (per-session CPU/RSS, H2 socket bytes). One mid-stream " +
		"browser-socket drop + redial with `after` + re-attach runs after the window while the others keep working. s3 keeps the same bounded history as s3-tools: its session is replaced " +
		`(newSession, issued through a short-lived client attached just for that call) before its first turn and then every ${TOOL_TURNS_PER_SESSION} turns, ` +
		`so its tool output stays under ${TOOL_HISTORY_BUDGET_BYTES / (1024 * 1024)} MiB and s3 is stationary across reps (tool.sessions counts the sessions used).`,
	async start(env) {
		const { stack } = env;
		const handles = [
			await stack.addSession({ label: "s1", slot: 0 }, await env.newRepo("c1"), { start: false }),
			await stack.addSession({ label: "s2", slot: 1 }, await env.newRepo("c2")),
			await stack.addSession({ label: "s3", slot: 2 }, await env.newRepo("c3")),
			await stack.addSession({ label: "s4", slot: 3 }, await env.newRepo("c4")),
		];
		const [h1, h2, h3, h4] = handles as [
			(typeof handles)[0],
			(typeof handles)[0],
			(typeof handles)[0],
			(typeof handles)[0],
		];
		const fixture = ensureHistoryFixture(join(env.outRoot, "fixtures"), SUB_THRESHOLD_HISTORY);
		const sessionFile = await materializeHistory(fixture, stack.sessionDirFor(h1.repo), h1.repo);
		const client = await ProfileClient.connect(env.adapter, stack.baseUrl);
		await client.send({
			type: "spawn_resume",
			id: crypto.randomUUID(),
			daemonId: h1.daemonId,
			sessionFile,
		});
		await stack.waitReady(h1, 120_000);
		await client.attach(h2.daemonId, h2.label);
		/** newSession on s3 through a client attached only for the call (the control API has no such verb). */
		const replaceS3Session = async (): Promise<void> => {
			const brief = await ProfileClient.connect(env.adapter, stack.baseUrl, { resilient: false });
			try {
				await brief.attach(h3.daemonId, h3.label, 60_000);
				await freshSession(brief);
			} finally {
				await brief.close();
			}
		};
		return {
			async rep(): Promise<RepOutcome> {
				const notes: string[] = [];
				const affinity = await env.verify(handles);
				const metrics: Record<string, MetricReading> = {};
				const idle = await idleRtt(client, 20);
				Object.assign(metrics, rttMetrics("rtt.idle", idle.rttMs, idle.failures));
				client.resetCounters();
				const chars = Math.round((env.durationMs / 1000) * DELTAS_PER_SEC * CHUNK_CHARS);
				const stopAt = Date.now() + env.durationMs;
				const failures: string[] = [];
				let s3Sessions = 0;
				const window = await env.window([client]);
				const probe = client.startRttProbe("getQueuedMessages", PROBE_INTERVAL_MS);
				const [turn, t1, t3, t4] = await Promise.all([
					client.prompt(
						textTurn({
							route: h2.label,
							chars,
							chunkChars: CHUNK_CHARS,
							deltasPerSec: DELTAS_PER_SEC,
						}),
						env.durationMs + 120_000,
					),
					ctlLoop(env, h1.daemonId, stopAt, () => idleTurn({ route: h1.label }), failures, 1000),
					ctlLoop(
						env,
						h3.daemonId,
						stopAt,
						() =>
							toolTurn({
								route: h3.label,
								calls: TOOL_CALLS_PER_TURN,
								outputBytes: TOOL_OUTPUT_BYTES,
							}),
						failures,
						0,
						async (turn) => {
							if (turn % TOOL_TURNS_PER_SESSION !== 0) return;
							await replaceS3Session();
							s3Sessions++;
						},
					),
					ctlLoop(
						env,
						h4.daemonId,
						stopAt,
						() => subagentTurn({ route: h4.label, agents: 4, textChars: 6000 }),
						failures,
						0,
					),
				]);
				const probed = await probe.stop();
				const closed = await window.close();
				Object.assign(metrics, closed.metrics);
				dropNotes(closed.drops, notes);
				Object.assign(metrics, rttMetrics("rtt.load", probed.rttMs, probed.failures));
				Object.assign(metrics, await streamMetrics(env, client, notes));
				Object.assign(metrics, resyncMetrics(client.byType, notes));
				metrics["turn.ms"] = metric(turn.turnMs, "ms", "info", "clock-monotonic-ffi");
				metrics["ctl.turns.s1"] = metric(t1, "count", "info");
				metrics["ctl.turns.s3"] = metric(t3, "count", "info");
				metrics["tool.sessions"] = metric(s3Sessions, "count", "info");
				metrics["ctl.turns.s4"] = metric(t4, "count", "info");
				metrics["ctl.failures"] = metric(failures.length, "count", "info");
				if (failures.length > 0)
					notes.push(`control prompt failures: ${failures.slice(0, 3).join("; ")}`);
				notes.push(frameBreakdown(client.byType));

				client.resetCounters();
				const interrupted = client.prompt(
					textTurn({
						route: h2.label,
						chars: 4000,
						chunkChars: CHUNK_CHARS,
						deltasPerSec: DELTAS_PER_SEC,
					}),
					60_000,
				);
				interrupted.catch(() => undefined);
				await Bun.sleep(400);
				Object.assign(metrics, reconnectMetrics(await client.reconnect(h2.daemonId, h2.label)));
				await interrupted;
				client.resetCounters();
				return { metrics, notes, affinity };
			},
			async close() {
				await client.close();
				for (const handle of handles) await stack.removeSession(handle);
			},
		};
	},
};
