/**
 * The Chromium pass (`--browser`): the S2 stream shape driven through the real
 * web UI in headless Chromium, against a second isolated fleet that serves the
 * UI. Latency is measured on the page's wall clock mapped onto the host's
 * monotonic timeline (see browser.ts), so it carries the `chromium-wall-clock`
 * label; CPU/RSS include the Chromium process tree pinned to its own cores.
 */
import { join } from "node:path";
import { chromiumPins, resolveChromium, runBrowserPass } from "./browser";
import { textTurn } from "./fake-model/directives";
import type { FakeModel } from "./fake-model/server";
import { MeasureWindow, percentileMetrics } from "./measure";
import { ensureAffinity } from "./pinning";
import { descendantPids } from "./proc";
import { Sampler } from "./sampler";
import { makeRepo, Stack } from "./stack";
import {
	metric,
	type AffinityRecord,
	type MetricReading,
	type PinPlan,
	type RepResult,
} from "./types";

const DELTAS_PER_SEC = 400;
const CHUNK_CHARS = 8;

export const BROWSER_SCENARIO = {
	id: "browser-s2",
	title: "Browser pass: S2 text stream through the real UI (Chromium)",
	description:
		"One session streams text at 400 deltas/s (the S2 shape) while headless Chromium drives the real web UI against a " +
		"second isolated fleet that serves it (bare mode, built dist/): click the roster row to attach, type the prompt, press " +
		"Send. Latencies are the page's wall clock mapped onto the host's CLOCK_MONOTONIC with an anchor measured in the harness " +
		"(label chromium-wall-clock): ttff and primed from the row click, stream.latency from model send to the page's frame event, " +
		"render-lag from frame arrival to the text being visible at an animation frame. Chromium runs on its own pinned cores " +
		"(taskset, tree re-pinned before and after the turn); its CPU and RSS are reported separately and are info-only. " +
		"No command RTT or reconnect here: the synthetic client covers those.",
} as const;

export interface BrowserPassContext {
	repoRoot: string;
	outDir: string;
	pin: PinPlan;
	fake: FakeModel;
	sendLog: string;
	warmups: number;
	reps: number;
	durationMs: number;
	chromiumPath?: string;
	bunArgs?: { fleet?: string[]; session?: (slot: number) => string[] };
	log: (message: string) => void;
}

export interface BrowserPassOutcome {
	results: RepResult[];
	chromium: { name: string; path: string };
}

/** `bun run build:web` when dist/index.html is missing (the fleet serves ./dist). */
async function ensureDist(repoRoot: string, log: (m: string) => void): Promise<void> {
	if (await Bun.file(join(repoRoot, "dist", "index.html")).exists()) return;
	log("dist/index.html missing: running bun run build:web");
	const proc = Bun.spawn(["bun", "run", "build:web"], {
		cwd: repoRoot,
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(`bun run build:web failed (${code}): ${err.trim().slice(-400)}`);
}

export async function runBrowserScenario(ctx: BrowserPassContext): Promise<BrowserPassOutcome> {
	await ensureDist(ctx.repoRoot, ctx.log);
	const found = await resolveChromium(ctx.chromiumPath);
	ctx.log(`chromium ${found.name} (${found.source}) ${found.path}`);
	const uiOutDir = join(ctx.outDir, "ui-stack");
	const stack = await Stack.start({
		repoRoot: ctx.repoRoot,
		outDir: uiOutDir,
		pin: ctx.pin,
		fakeModelUrl: ctx.fake.url,
		serveUi: true,
		...(ctx.bunArgs !== undefined ? { bunArgs: ctx.bunArgs } : {}),
	});
	let chromiumRoot: number | undefined;
	const sampler = new Sampler([
		{
			label: "fleet",
			pids: () => {
				const owned = new Set(stack.sessions.flatMap((h) => h.treePids()));
				return descendantPids(stack.fleetPid).filter((p) => !owned.has(p));
			},
		},
		{ label: "s2", pids: () => stack.sessions.find((h) => h.label === "s2")?.treePids() ?? [] },
		{
			label: "chromium",
			pids: () => (chromiumRoot === undefined ? [] : chromiumPins(chromiumRoot)),
		},
	]);
	sampler.start();
	const results: RepResult[] = [];
	try {
		const repo = await makeRepo(join(uiOutDir, "repos", "browser-s2"));
		const handle = await stack.addSession({ label: "s2", slot: 1 }, repo);
		const total = ctx.warmups + ctx.reps;
		for (let i = 0; i < total; i++) {
			const warmup = i < ctx.warmups;
			const rep = warmup ? 0 : i - ctx.warmups + 1;
			const t0 = performance.now();
			const affinity: AffinityRecord[] = [];
			if (ctx.pin.enabled) affinity.push(...(await stack.verifyPinning([handle])));
			let window: MeasureWindow | undefined;
			const chars = Math.round((ctx.durationMs / 1000) * DELTAS_PER_SEC * CHUNK_CHARS);
			const result = await runBrowserPass({
				baseUrl: stack.baseUrl,
				sessionDaemonId: handle.daemonId,
				route: handle.label,
				sendLog: ctx.sendLog,
				directivePrompt: textTurn({
					route: handle.label,
					chars,
					chunkChars: CHUNK_CHARS,
					deltasPerSec: DELTAS_PER_SEC,
				}),
				headless: true,
				...(ctx.chromiumPath !== undefined ? { chromiumPath: ctx.chromiumPath } : {}),
				...(ctx.pin.enabled ? { pinCpus: ctx.pin.chromium } : {}),
				timeoutMs: ctx.durationMs + 120_000,
				flushSendLog: () => ctx.fake.flush(),
				onLaunch: async (root) => {
					chromiumRoot = root;
				},
				onPageReady: async (root) => {
					chromiumRoot = root;
					if (ctx.pin.enabled) {
						affinity.push(
							...(await ensureAffinity("chromium", chromiumPins(root), ctx.pin.chromium)),
						);
					}
					window = await MeasureWindow.open({
						sampler,
						fleetPort: stack.port,
						sessionLabels: ["s2"],
						clients: [],
						owner: (pid) =>
							stack.sessions.some((h) => h.treePids().includes(pid)) ? "s2" : "other",
					});
				},
			});
			chromiumRoot = undefined;
			const closed = window === undefined ? undefined : await window.close();
			const metrics: Record<string, MetricReading> = { ...closed?.metrics };
			// The synthetic-client frame counters are not available here; the page's count is.
			delete metrics["h1.frames/s"];
			delete metrics["h1.down.bytes/s"];
			delete metrics["h1.up.bytes/s"];
			delete metrics["h1.frame-bytes/frame"];
			delete metrics["h1.frames"];
			delete metrics["cpu.fleet+sessions.ms/1k-h1-frames"];
			delete metrics["cpu.fleet.ms/1k-h1-frames"];
			delete metrics["cpu.sessions.ms/1k-h1-frames"];
			delete metrics["h2.bytes-per-h1-frame"];
			const wall = "chromium-wall-clock" as const;
			metrics["browser.ttff.ms"] = metric(result.ttffMs, "ms", "lower", wall);
			metrics["browser.primed.ms"] = metric(result.primedMs, "ms", "lower", wall);
			if (result.firstDeltaMs !== undefined) {
				metrics["browser.first-delta.ms"] = metric(result.firstDeltaMs, "ms", "lower", wall);
			}
			if (result.renderedFirstDeltaMs !== undefined) {
				metrics["browser.first-delta-rendered.ms"] = metric(
					result.renderedFirstDeltaMs,
					"ms",
					"lower",
					wall,
				);
			}
			metrics["browser.turn.ms"] = metric(result.uiTurnMs, "ms", "info", wall);
			metrics["browser.frames"] = metric(result.framesReceived, "count", "info");
			metrics["browser.delta-frames"] = metric(result.deltaFrames, "count", "info");
			if (result.renderLag.p50Ms !== undefined) {
				metrics["browser.render-lag.p50"] = metric(result.renderLag.p50Ms, "ms", "lower", wall);
			}
			if (result.renderLag.p95Ms !== undefined) {
				metrics["browser.render-lag.p95"] = metric(result.renderLag.p95Ms, "ms", "lower", wall);
			}
			Object.assign(
				metrics,
				percentileMetrics(
					"stream.latency",
					result.latencyNs.map((ns) => Number(ns) / 1e6),
					wall,
				),
			);
			metrics["stream.unmatched"] = metric(result.unmatched, "count", "info");
			const notes = [
				...result.notes,
				`browser: ${result.browser.name} ${result.browser.version} (${result.browser.source}), ${result.browser.headless ? "headless" : "headed"}`,
				`stream latency is wall-clock based: anchor offset spread ${Number(result.anchor.spreadNs) / 1000} us, drift ${Number(result.anchor.driftNs) / 1000} us`,
				`render-lag: ${result.renderLag.label} (${result.renderLag.count} deltas visible, ${result.renderLag.pending} pending)`,
				`the measured window opens when the UI is loaded and closes when Chromium has been torn down; the H1 frame count is the page's (all frame types since load)`,
				`chromium pids at the end of the turn: ${result.chromiumPids.length}`,
			];
			affinity.push(...result.affinity);
			results.push({
				scenarioId: BROWSER_SCENARIO.id,
				rep,
				warmup,
				durationMs: performance.now() - t0,
				metrics,
				notes,
				affinity,
			});
			ctx.log(
				`${BROWSER_SCENARIO.id}: ${warmup ? "warmup" : `rep ${rep}/${ctx.reps}`} done in ${((performance.now() - t0) / 1000).toFixed(1)} s`,
			);
		}
		return {
			results,
			chromium: {
				name: found.name.includes(found.version) ? found.name : `${found.name} ${found.version}`,
				path: found.path,
			},
		};
	} finally {
		sampler.stop();
		await stack.stop();
	}
}
