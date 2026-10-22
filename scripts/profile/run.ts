/**
 * The runner: boots the isolated stack, runs the liveness check and scenarios,
 * and turns the results into a summary. Owns every long-lived resource and
 * tears all of it down (sessions, fleet, fake model, leftover processes) on
 * every path, including SIGINT/SIGTERM.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ProfileClient, RecoveryFailed } from "./client";
import { BROWSER_SCENARIO, runBrowserScenario } from "./browser-pass";
import { loadSummary, compareSummaries, renderComparisonMarkdown } from "./compare";
import { ssePostAdapter } from "./adapters/sse-post";
import { startFakeModelProcess, type FakeModelProcess } from "./fake-process";
import { collectFingerprint } from "./host";
import { joinLatency } from "./latency";
import { MeasureWindow } from "./measure";
import { Perturbation } from "./perturb";
import { ensureAffinity, defaultPinPlan } from "./pinning";
import { descendantPids } from "./proc";
import { Sampler } from "./sampler";
import { LivenessError, checkLiveness } from "./scenarios/liveness";
import type { RepOutcome, RunEnv, Scenario } from "./scenarios/env";
import { SCENARIOS } from "./scenarios/index";
import { makeRepo, reapLeftovers, Stack } from "./stack";
import {
	BASELINES_DIR,
	buildSummary,
	harnessWarnings,
	renderSummaryMarkdown,
	saveBaseline,
	writeSummary,
} from "./summary";
import type { AffinityRecord, RepResult, RunOptions, Summary } from "./types";

const SAMPLE_LABELS = ["fleet", "s1", "s2", "s3", "s4"];

function log(message: string): void {
	console.error(`[profile] ${message}`);
}

/** A port nothing listens on: the broken-fake-model demonstration. */
async function deadUrl(): Promise<string> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const url = `http://127.0.0.1:${probe.port}`;
	await probe.stop(true);
	return url;
}

export interface RunResult {
	exitCode: number;
	summary?: Summary;
	summaryPaths?: { jsonPath: string; mdPath: string };
}

export async function runProfile(
	options: RunOptions,
	outRoot: string,
	repoRoot: string,
): Promise<RunResult> {
	const startedAt = new Date();
	mkdirSync(options.outDir, { recursive: true });
	const pin = defaultPinPlan({ noPin: options.noPin });
	if (!pin.enabled) log(`pinning disabled: ${pin.disabledReason ?? "unknown"}`);
	const sendLog = join(options.outDir, "send-log.ndjson");
	let fake: FakeModelProcess | undefined;
	let stack: Stack | undefined;
	let sampler: Sampler | undefined;
	const clients: ProfileClient[] = [];
	let interrupted = false;
	const onSignal = (): void => {
		interrupted = true;
		log("interrupted; shutting down");
		void cleanup().then(() => process.exit(130));
	};
	const cleanup = async (): Promise<void> => {
		sampler?.stop();
		for (const c of clients) await c.close().catch(() => undefined);
		await stack?.stop().catch(() => undefined);
		await fake?.close().catch(() => undefined);
		reapLeftovers(options.outDir, "SIGKILL");
		stack = undefined;
		fake = undefined;
	};
	// An error that escapes every await (a stray rejection) must still tear everything down.
	const onFatal = (err: unknown): void => {
		console.error("[profile] fatal:", err);
		void cleanup().then(() => process.exit(1));
	};
	process.on("uncaughtException", onFatal);
	process.on("unhandledRejection", onFatal);
	process.once("SIGINT", onSignal);
	process.once("SIGTERM", onSignal);
	try {
		fake = await startFakeModelProcess({
			sendLog,
			...(pin.enabled ? { cpus: pin.fakeModel } : {}),
		});
		log(`fake model ${fake.url} (own process, pid ${fake.pid})`);
		const fakeUrlForSessions = options.breakFakeModel ? await deadUrl() : fake.url;
		if (options.breakFakeModel) log(`DELIBERATELY BROKEN: sessions point at ${fakeUrlForSessions}`);
		const perturbation = await Perturbation.create(
			{ cpuprofile: options.cpuprofile, heap: options.heap },
			options.outDir,
		);
		if (perturbation.active) log(`PERTURBED run: ${perturbation.labels().join("; ")}`);
		stack = await Stack.start({
			repoRoot,
			outDir: options.outDir,
			pin,
			fakeModelUrl: fakeUrlForSessions,
			bunArgs: {
				fleet: perturbation.fleetArgs(),
				session: (slot) => perturbation.sessionArgs(slot),
			},
		});
		const liveStack = stack;
		log(`fleet pid ${liveStack.fleetPid} on ${liveStack.baseUrl}`);
		const liveFake = fake;

		sampler = new Sampler(
			SAMPLE_LABELS.map((label) => ({
				label,
				pids: () => {
					if (label === "fleet") {
						const owned = new Set(liveStack.sessions.flatMap((h) => h.treePids()));
						return descendantPids(liveStack.fleetPid).filter((p) => !owned.has(p));
					}
					return liveStack.sessions.find((h) => h.label === label)?.treePids() ?? [];
				},
			})),
		);
		sampler.start();
		const liveSampler = sampler;

		const sessionOwner = (pid: number): string => {
			if (pid === process.pid) return "harness";
			for (const h of liveStack.sessions) if (h.treePids().includes(pid)) return h.label;
			return "other";
		};

		let repoCounter = 0;
		const env: RunEnv = {
			repoRoot,
			outDir: options.outDir,
			outRoot,
			stack: liveStack,
			fake: liveFake,
			sendLog,
			adapter: ssePostAdapter,
			pin,
			durationMs: options.durationMs,
			quick: options.quick,
			newRepo: (name) => makeRepo(join(options.outDir, "repos", `${++repoCounter}-${name}`)),
			async verify(handles) {
				if (!pin.enabled) return [];
				const records: AffinityRecord[] = await liveStack.verifyPinning(handles);
				records.push(...(await ensureAffinity("harness", [process.pid], pin.harness)));
				records.push(
					...(await ensureAffinity("fake-model", [liveFake.pid], pin.fakeModel ?? pin.harness)),
				);
				return records;
			},
			window: (windowClients) =>
				MeasureWindow.open({
					sampler: liveSampler,
					fleetPort: liveStack.port,
					sessionLabels: ["s1", "s2", "s3", "s4"],
					clients: windowClients,
					owner: sessionOwner,
				}),
			async joinStream(client) {
				await liveFake.flush();
				return joinLatency(sendLog, client.recv);
			},
		};

		// Liveness first (always cheap): a broken stack fails here, not 3 minutes in.
		if (options.liveness || options.quick) {
			log("liveness check");
			const t0 = performance.now();
			try {
				const report = await checkLiveness(env);
				log(
					`liveness ok: ${report.frames} frames, ${report.textDeltas} text deltas, turn ${report.turnMs.toFixed(0)} ms, ` +
						`idle; ${((performance.now() - t0) / 1000).toFixed(1)} s`,
				);
			} catch (err) {
				const reason =
					err instanceof LivenessError ? err.message : `liveness crashed: ${String(err)}`;
				console.error(`LIVENESS FAILED: ${reason}`);
				return { exitCode: 1 };
			}
			if (options.liveness) return { exitCode: 0 };
		}

		const selected = selectScenarios(options.scenarios);
		const results: Array<{ id: string; title: string; description: string; results: RepResult[] }> =
			[];
		for (const scenario of selected) {
			if (interrupted) break;
			log(`${scenario.id}: starting`);
			const run = await scenario.start(env);
			const reps: RepResult[] = [];
			try {
				const total = options.warmups + options.reps;
				for (let i = 0; i < total; i++) {
					const warmup = i < options.warmups;
					const rep = warmup ? 0 : i - options.warmups + 1;
					// A quick run keeps its warmup short: it only has to take the cold start (JIT, caches).
					env.durationMs =
						warmup && options.quick ? Math.min(3000, options.durationMs) : options.durationMs;
					const t0 = performance.now();
					const fromEpochMs = Date.now();
					let outcome: RepOutcome;
					try {
						outcome = await run.rep(rep);
					} catch (err) {
						// A client that could not recover its downlink invalidates the rep, not the run.
						if (!(err instanceof RecoveryFailed)) throw err;
						outcome = { metrics: {}, notes: [err.message], affinity: [], failed: err.message };
					}
					const toEpochMs = Date.now();
					const durationMs = performance.now() - t0;
					if (!warmup) perturbation.recordWindow(scenario.id, fromEpochMs, toEpochMs);
					Object.assign(
						outcome.metrics,
						await perturbation.readHeaps(
							liveStack.sessions.map((h) => ({ label: h.label, slot: h.slot })),
						),
					);
					reps.push({
						scenarioId: scenario.id,
						rep,
						warmup,
						durationMs,
						metrics: outcome.metrics,
						notes: outcome.notes,
						affinity: outcome.affinity,
						...(outcome.failed !== undefined ? { failed: outcome.failed } : {}),
					});
					if (outcome.failed !== undefined) log(`${scenario.id}: rep FAILED: ${outcome.failed}`);
					log(
						`${scenario.id}: ${warmup ? "warmup" : `rep ${rep}/${options.reps}`} done in ${(durationMs / 1000).toFixed(1)} s`,
					);
				}
			} finally {
				perturbation.recordSessions(
					scenario.id,
					liveStack.sessions.map((h) => ({ label: h.label, name: h.name })),
				);
				await run.close();
			}
			await perturbation.collectSessions(scenario.id);
			results.push({
				id: scenario.id,
				title: scenario.title,
				description: scenario.description,
				results: reps,
			});
		}

		if (perturbation.cpuprofile) {
			// The fleet writes its profile when it exits.
			await liveStack.stop();
			await perturbation.collectFleet(results.map((r) => r.id));
		}
		let chromium: { name: string; path: string } | undefined;
		if (options.browser && !interrupted) {
			// The browser pass runs its own UI-serving fleet; the first one is no longer needed.
			await liveStack.stop();
			const outcome = await runBrowserScenario({
				repoRoot,
				outDir: options.outDir,
				pin,
				fake: liveFake,
				sendLog,
				warmups: options.warmups,
				reps: options.reps,
				durationMs: options.durationMs,
				...(options.chromiumPath !== undefined ? { chromiumPath: options.chromiumPath } : {}),
				log,
			});
			chromium = outcome.chromium;
			results.push({
				id: BROWSER_SCENARIO.id,
				title: BROWSER_SCENARIO.title,
				description: BROWSER_SCENARIO.description,
				results: outcome.results,
			});
		}
		const finishedAt = new Date();
		const fingerprint = await collectFingerprint({
			repoRoot,
			pin,
			transport: ssePostAdapter.name,
			...(chromium !== undefined ? { chromium } : {}),
		});
		await liveFake.close();
		const extras: Record<string, unknown> = perturbation.active ? perturbation.extras() : {};
		if (liveFake.loopLag !== undefined) {
			extras["fake-model-loop-lag"] = {
				note: "Event-loop lag (ms) of the fake model process over the whole run; it paces the model stream, so stalls there would delay deltas.",
				...liveFake.loopLag,
			};
		}
		const summary = buildSummary({
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			args: { ...options },
			fingerprint,
			perturbed: perturbation.labels(),
			extras,
			scenarios: results,
		});
		const summaryPaths = await writeSummary(options.outDir, summary);
		log(`summary: ${summaryPaths.mdPath}`);
		if (options.saveBaseline !== undefined) {
			const saved = await saveBaseline(
				summary,
				options.saveBaseline,
				join(repoRoot, BASELINES_DIR),
				{ overwrite: options.overwriteBaseline === true },
			);
			log(`baseline saved: ${saved.jsonPath}`);
		}
		for (const warning of harnessWarnings(summary)) log(`WARNING: ${warning}`);
		console.log(renderSummaryMarkdown(summary));
		if (options.compare !== undefined) {
			const baseline = await loadSummary(options.compare);
			console.log(renderComparisonMarkdown(compareSummaries(summary, baseline)));
		}
		return { exitCode: 0, summary, summaryPaths };
	} finally {
		process.off("uncaughtException", onFatal);
		process.off("unhandledRejection", onFatal);
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		await cleanup();
	}
}

function selectScenarios(ids: string[]): Scenario[] {
	if (ids.length === 0) return SCENARIOS;
	const known = SCENARIOS.map((s) => s.id);
	const unknown = ids.filter((id) => !known.includes(id));
	if (unknown.length > 0) {
		throw new Error(`unknown scenario ${unknown.join(", ")}; known: ${known.join(", ")}`);
	}
	return SCENARIOS.filter((s) => ids.includes(s.id));
}
