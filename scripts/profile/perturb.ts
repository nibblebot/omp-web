/**
 * Opt-in perturbing instrumentation: `--cpuprofile` (bun --cpu-prof on the
 * fleet and every session) and `--heap` (bun --inspect plus an end-of-rep
 * heap read). Both change what they measure, so runs that use them are
 * labeled `perturbed` in the summary and are not comparable to plain runs.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	BUCKET_NAMES,
	type BucketName,
	type BucketedProfile,
	bucketCpuProfile,
	type TopFunction,
} from "./cpuprofile";
import { type HeapReading, inspectFlags, pickInspectPort, readHeap } from "./heap";
import { metric, type MetricReading } from "./types";

/** Fine enough for the fleet to yield samples inside a rep; the 1 ms default gave about 15. */
const PROFILE_INTERVAL_US = 100;
const SESSION_SLOTS = 4;
const MIB = 1024 * 1024;

export interface BucketTotals {
	/** Active (non-idle) self time summed over the measured reps, ms. */
	totalMs: number;
	buckets: Record<BucketName, { ms: number; pct: number }>;
	top: TopFunction[];
	reps: number;
}

interface Window {
	fromEpochMs: number;
	toEpochMs: number;
}

/** Sum bucketed profiles of several windows of one process (percentages recomputed over the sum). */
function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

function mergeProfiles(profiles: BucketedProfile[]): BucketTotals {
	const ms: Record<string, number> = {};
	const topByKey: Record<string, TopFunction> = {};
	let wall = 0;
	for (const profile of profiles) {
		wall += profile.windowMs;
		for (const name of BUCKET_NAMES) ms[name] = (ms[name] ?? 0) + profile.buckets[name].ms;
		for (const t of profile.top) {
			const key = `${t.fn}\u0000${t.url}`;
			const prev = topByKey[key];
			if (prev === undefined) topByKey[key] = { ...t };
			else prev.ms += t.ms;
		}
	}
	let active = 0;
	for (const name of BUCKET_NAMES) if (name !== "idle") active += ms[name] ?? 0;
	const buckets = {} as BucketTotals["buckets"];
	for (const name of BUCKET_NAMES) {
		const value = ms[name] ?? 0;
		const base = name === "idle" ? wall : active;
		buckets[name] = { ms: round2(value), pct: round2(base === 0 ? 0 : (value / base) * 100) };
	}
	const top = Object.values(topByKey)
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 15)
		.map((t) => ({ ...t, ms: round2(t.ms) }));
	return { totalMs: round2(active), buckets, top, reps: profiles.length };
}

/** `bun` argv, rep windows and result collection for one run's instrumentation. */
export class Perturbation {
	readonly cpuprofile: boolean;
	readonly heap: boolean;
	readonly profDir: string;
	#fleetPort = 0;
	readonly #slotPorts: number[] = [];
	/** Measured-rep windows per scenario id. */
	readonly #windows: Record<string, Window[]> = {};
	/** `<scenario>/<label>` -> profile file stem, filled when the scenario's sessions are known. */
	readonly #sessionFiles: Record<string, string> = {};
	readonly #result: Record<string, Record<string, BucketTotals>> = {};
	readonly notes: string[] = [];

	private constructor(opts: { cpuprofile: boolean; heap: boolean }, outDir: string) {
		this.cpuprofile = opts.cpuprofile;
		this.heap = opts.heap;
		this.profDir = join(outDir, "cpuprofiles");
	}

	static async create(
		opts: { cpuprofile: boolean; heap: boolean },
		outDir: string,
	): Promise<Perturbation> {
		const p = new Perturbation(opts, outDir);
		if (opts.cpuprofile) mkdirSync(p.profDir, { recursive: true });
		if (opts.heap) {
			p.#fleetPort = await pickInspectPort();
			for (let i = 0; i < SESSION_SLOTS; i++) p.#slotPorts.push(await pickInspectPort());
		}
		return p;
	}

	get active(): boolean {
		return this.cpuprofile || this.heap;
	}

	/** Labels for the summary's `perturbed` list. */
	labels(): string[] {
		const out: string[] = [];
		if (this.cpuprofile) {
			out.push(
				`cpuprofile: bun --cpu-prof (${PROFILE_INTERVAL_US} us sampling) on the fleet and every session; timings are perturbed, do not compare against unprofiled runs`,
			);
		}
		if (this.heap) {
			out.push(
				"heap: bun --inspect on the fleet and every session, JS heap read after a forced GC at the end of each rep; memory and timings are perturbed",
			);
		}
		return out;
	}

	fleetArgs(): string[] {
		return [
			...(this.cpuprofile ? this.#profileFlags("fleet") : []),
			...(this.heap ? inspectFlags(this.#fleetPort) : []),
		];
	}

	/** Session argv for a pin slot. The profile file is named after the session (`{name}` is filled by the fleet's spawn template). */
	sessionArgs(slot: number): string[] {
		return [
			...(this.cpuprofile ? this.#profileFlags("{name}") : []),
			...(this.heap ? inspectFlags(this.#slotPorts[slot]!) : []),
		];
	}

	#profileFlags(stem: string): string[] {
		return [
			"--cpu-prof",
			"--cpu-prof-dir",
			this.profDir,
			"--cpu-prof-name",
			`${stem}.cpuprofile`,
			"--cpu-prof-interval",
			String(PROFILE_INTERVAL_US),
		];
	}

	/** Record a measured rep's wall window (epoch ms) for the scenario. */
	recordWindow(scenarioId: string, fromEpochMs: number, toEpochMs: number): void {
		(this.#windows[scenarioId] ??= []).push({ fromEpochMs, toEpochMs });
	}

	/** Remember which profile file each session label of a scenario will write. */
	recordSessions(scenarioId: string, sessions: Array<{ label: string; name: string }>): void {
		for (const s of sessions) this.#sessionFiles[`${scenarioId}/${s.label}`] = s.name;
	}

	/** Heap readings of the fleet and the scenario's live sessions as rep metrics. */
	async readHeaps(
		slots: Array<{ label: string; slot: number }>,
	): Promise<Record<string, MetricReading>> {
		const out: Record<string, MetricReading> = {};
		if (!this.heap) return out;
		const targets = [{ label: "fleet", port: this.#fleetPort }];
		for (const s of slots) targets.push({ label: s.label, port: this.#slotPorts[s.slot]! });
		for (const t of targets) {
			const reading: HeapReading | undefined = await readHeap(t.port, this.notes);
			if (reading === undefined) continue;
			out[`heap.${t.label}.used-MiB`] = metric(reading.usedBytes / MIB, "MiB", "info");
			out[`heap.${t.label}.external-MiB`] = metric(reading.externalBytes / MIB, "MiB", "info");
		}
		return out;
	}

	/** Bucket the session profiles of one scenario once its sessions have exited. */
	async collectSessions(scenarioId: string): Promise<void> {
		if (!this.cpuprofile) return;
		const windows = this.#windows[scenarioId] ?? [];
		const labels = Object.keys(this.#sessionFiles).filter((k) => k.startsWith(`${scenarioId}/`));
		for (const key of labels) {
			const stem = this.#sessionFiles[key]!;
			const path = join(this.profDir, `${stem}.cpuprofile`);
			const label = key.slice(scenarioId.length + 1);
			if (!(await waitForFile(path, 10_000))) {
				this.notes.push(`${scenarioId}/${label}: no cpuprofile at ${path}`);
				continue;
			}
			(this.#result[scenarioId] ??= {})[label] = await this.#bucket(path, windows);
		}
	}

	/** Bucket the fleet profile (written when the fleet exits) for every scenario window. Call after Stack.stop(). */
	async collectFleet(scenarioIds: string[]): Promise<void> {
		if (!this.cpuprofile) return;
		const path = join(this.profDir, "fleet.cpuprofile");
		if (!(await waitForFile(path, 10_000))) {
			this.notes.push(`no fleet cpuprofile at ${path}`);
			return;
		}
		for (const id of scenarioIds) {
			(this.#result[id] ??= {})["fleet"] = await this.#bucket(path, this.#windows[id] ?? []);
		}
	}

	async #bucket(path: string, windows: Window[]): Promise<BucketTotals> {
		const profiles: BucketedProfile[] = [];
		for (const w of windows) profiles.push(await bucketCpuProfile(path, { window: w }));
		return mergeProfiles(profiles);
	}

	/** The `extras` entry of the summary: bucket tables per scenario and process. */
	extras(): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		if (this.cpuprofile) {
			out["cpuprofile-buckets"] = {
				note: "Self time of JS execution only (Bun samples while JS runs), summed over each scenario's measured reps, bucketed by frame name; percentages are shares of active (non-idle) sampled time. Timings are perturbed by profiling.",
				scenarios: this.#result,
			};
		}
		if (this.notes.length > 0) out["perturbation-notes"] = this.notes;
		return out;
	}
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(path)) return true;
		await Bun.sleep(100);
	}
	return existsSync(path);
}
