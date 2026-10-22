/**
 * What a scenario sees: the running stack, the fake model, the sampler and the
 * helpers the runner owns. Scenarios never start or stop shared infrastructure.
 */
import type { ProfileClient } from "../client";
import type { FakeModel } from "../fake-model/server";
import type { MeasureWindow } from "../measure";
import type { SessionHandle, Stack } from "../stack";
import type { AffinityRecord, MetricReading, PinPlan, TransportAdapter } from "../types";

export interface RunEnv {
	repoRoot: string;
	/** `.profile-out/run-<ts>`: per-run scratch and logs. */
	outDir: string;
	/** `.profile-out`: shared across runs (fixture cache). */
	outRoot: string;
	stack: Stack;
	fake: FakeModel;
	sendLog: string;
	adapter: TransportAdapter;
	pin: PinPlan;
	/** Measured window length a scenario aims for (quick runs shorten it). */
	durationMs: number;
	quick: boolean;
	/** A fresh git repo under the run dir. */
	newRepo(name: string): Promise<string>;
	/** Pin-verify the fleet and `handles`; the records go into the rep result. */
	verify(handles: SessionHandle[]): Promise<AffinityRecord[]>;
	/** Open a measurement window over `clients` (H1 counters) and every process group. */
	window(clients: ProfileClient[]): Promise<MeasureWindow>;
	/** Join the client's receive records with the fake model's send log (flushes it first). */
	joinStream(client: ProfileClient): Promise<{ ns: bigint[]; unmatched: number; sendOnly: number }>;
}

/** One rep's measured outcome; the runner adds timing and the affinity record. */
export interface RepOutcome {
	metrics: Record<string, MetricReading>;
	notes: string[];
	affinity: AffinityRecord[];
	/** Set when the rep is invalid; see `RepResult.failed`. */
	failed?: string;
}

/** A scenario after `start`: its sessions exist and are ready; `rep` can run repeatedly. */
export interface ScenarioRun {
	rep(index: number): Promise<RepOutcome>;
	close(): Promise<void>;
}

export interface Scenario {
	id: string;
	title: string;
	/** What it does and which side observes what; rendered into summary.md. */
	description: string;
	start(env: RunEnv): Promise<ScenarioRun>;
}

/** Latency samples in ms from nanosecond differences. */
export function nsToMsList(ns: bigint[]): number[] {
	return ns.map((v) => Number(v) / 1e6);
}
