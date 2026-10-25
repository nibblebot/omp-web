/**
 * S4: subagent fan-out. One session spawns subagents that each stream text;
 * the browser client sees the parent stream plus subagent lifecycle/progress frames.
 */
import { ProfileClient } from "../client";
import { subagentTurn } from "../fake-model/directives";
import { metric, type MetricReading } from "../types";
import {
	dropNotes,
	frameBreakdown,
	resyncMetrics,
	idleRtt,
	rttMetrics,
	streamMetrics,
} from "./common";
import type { RepOutcome, Scenario } from "./env";

const AGENTS = 4;
const TEXT_CHARS = 6000;
const PROBE_INTERVAL_MS = 250;

export const s4Subagents: Scenario = {
	id: "s4-subagents",
	title: "S4 subagent fan-out",
	description:
		`One session (pin slot 6, route s4) runs turns whose single task call spawns ${AGENTS} subagents, each streaming ` +
		`${TEXT_CHARS} chars, repeated until the rep window elapses. The wire carries subagent_lifecycle/subagent_progress ` +
		"frames (never subagent text deltas), so H1 frames here are progress traffic plus the parent's own text; stream " +
		"latency joins only the parent's deltas (subagent chunks show as sent-only). The attached client probes command RTT every 250 ms.",
	async start(env) {
		const repo = await env.newRepo("s4");
		const handle = await env.stack.addSession({ label: "s4", slot: 3 }, repo);
		const client = await ProfileClient.connect(env.adapter, env.stack.baseUrl);
		await client.attach(handle.workspaceId, handle.label);
		return {
			async rep(): Promise<RepOutcome> {
				const notes: string[] = [];
				const affinity = await env.verify([handle]);
				const metrics: Record<string, MetricReading> = {};
				const idle = await idleRtt(client, 10);
				Object.assign(metrics, rttMetrics("rtt.idle", idle.rttMs, idle.failures));
				client.resetCounters();
				const window = await env.window([client]);
				const probe = client.startRttProbe("getQueuedMessages", PROBE_INTERVAL_MS);
				const startedAt = Date.now();
				let turns = 0;
				do {
					await client.prompt(
						subagentTurn({ route: handle.label, agents: AGENTS, textChars: TEXT_CHARS }),
						180_000,
					);
					turns++;
				} while (Date.now() - startedAt < env.durationMs);
				const probed = await probe.stop();
				const closed = await window.close();
				Object.assign(metrics, closed.metrics);
				dropNotes(closed.drops, notes);
				Object.assign(metrics, rttMetrics("rtt.load", probed.rttMs, probed.failures));
				Object.assign(metrics, await streamMetrics(env, client, notes));
				Object.assign(metrics, resyncMetrics(client.byType, notes));
				metrics["subagent.turns"] = metric(turns, "count", "info");
				metrics["subagent.agents"] = metric(turns * AGENTS, "count", "info");
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
