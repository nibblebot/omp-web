/**
 * Browser pass: drive the real web UI in headless Chromium against a fleet that
 * serves it, and measure what the user would see.
 *
 * Fleet requirements (what the Stack must run):
 * - the fleet must serve the UI: run `apps/fleet/cli.ts` bare (NOT the `control`
 *   subcommand, which answers static paths with 404 JSON), with `--no-open`,
 *   cwd = repo root (the edge reads `./dist` relative to the process cwd);
 * - `dist/index.html` must exist: `bun run build:web` (vite, a couple of seconds,
 *   writes the gitignored repo-root `dist/`).
 *
 * Flow: launch Chromium (pinned when `pinCpus` is set), open the UI, wait for
 * the roster row of the session, click it (real attach), wait for priming, type
 * the directive prompt into the composer, click Send, wait for `agent_end` and
 * for the DOM to show every delta. Frame stamping and DOM-render tracking run in
 * the page (see ./browser/probe.ts); times are Chromium wall-clock milliseconds
 * mapped onto the host's CLOCK_MONOTONIC timeline with an anchor measured in
 * this process, so `joinLatency` against the fake model's send log works.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium as playwright } from "playwright-core";
import {
	chromiumPins,
	findLaunchedRoot,
	killChromiumTree,
	launchExecutable,
	launchedRoots,
	type ResolvedChromium,
	resolveChromium,
	userDataDirOf,
} from "./browser/chromium";
import { installProbe, type ProbeClick, type ProbeConfig, type ProbeData } from "./browser/probe";
import { monotonicNs } from "./clock";
import { joinLatency, type RecvRecord } from "./latency";
import { ensureAffinity } from "./pinning";
import { median, percentile } from "./stats";
import type { AffinityRecord, ClockSource } from "./types";

export { chromiumPins, resolveChromium };
export type { ResolvedChromium };

const PROBE_KEY = "__ompProfileProbe";
const NS_PER_MS = 1_000_000n;
const ANCHOR_SAMPLES = 15;
const COMPOSER = "textarea[aria-label='Message the agent']";
const SEND = "button.send[aria-label='Send']";
const VIEWPORT = { width: 1280, height: 800 };
/** Flags that keep a headless tab at full speed regardless of focus/occlusion heuristics. */
const BROWSER_ARGS = [
	"--disable-background-timer-throttling",
	"--disable-renderer-backgrounding",
	"--disable-backgrounding-occluded-windows",
	"--disable-extensions",
	"--no-first-run",
	"--no-default-browser-check",
];

export interface BrowserPassOptions {
	/** Fleet origin that serves the UI (bare fleet, see the file header). */
	baseUrl: string;
	/** Workspace id of the session to attach and prompt. */
	workspaceId: string;
	/** Latency route label: the `route` the directive prompt carries. */
	route: string;
	/** Fake model send log (NDJSON), joined after the turn. */
	sendLog: string;
	/** Prompt text to put in the composer (a `textTurn` prompt). */
	directivePrompt: string;
	headless: true;
	/** Explicit Chromium binary (`--chromium-path`); `PROFILE_CHROMIUM` still wins. */
	chromiumPath?: string;
	/** Launch Chromium under `taskset -c <cpus>` so its whole tree is pinned from birth. */
	pinCpus?: string;
	/** Called after launch and BEFORE navigation with the browser root pid (pin the tree here). */
	onLaunch?: (rootPid: number) => Promise<void>;
	/**
	 * Called once the UI has loaded and its renderer/gpu/utility processes exist, before the
	 * attach click: re-pin the tree here (`chromiumPins(rootPid)` lists the current pids).
	 */
	onPageReady?: (rootPid: number) => Promise<void>;
	/** Flush the fake model's send log; awaited right before the join. */
	flushSendLog?: () => Promise<void>;
	/** Overall deadline per wait (attach, turn), default 120 s. */
	timeoutMs?: number;
}

export interface RenderLagStats {
	/** Deltas whose text became visible in the DOM at an animation frame. */
	count: number;
	/** Deltas still not visible at the end of the wait. */
	pending: number;
	p50Ms: number | undefined;
	p95Ms: number | undefined;
	/** What the numbers mean, for reports. */
	label: string;
}

export interface BrowserPassResult {
	browser: {
		name: string;
		version: string;
		path: string;
		headless: boolean;
		source: ResolvedChromium["source"];
		rootPid: number;
	};
	clock: ClockSource;
	/** Row click to the first session frame (`attached`). */
	ttffMs: number;
	/** Row click to priming complete (`available_commands` after the final `history`). */
	primedMs: number;
	/** Send click to the first delta's text being visible in the DOM (at an animation frame). */
	renderedFirstDeltaMs: number | undefined;
	/** Send click to the first `text_delta` frame arriving in the page. */
	firstDeltaMs: number | undefined;
	/** Per-delta stream latency, model send to the page's frame event (ns, bigint). */
	latencyNs: bigint[];
	unmatched: number;
	/** Every `frame` event the page received (all types) since load. */
	framesReceived: number;
	/** Main-session `text_delta` frames the page received. */
	deltaFrames: number;
	/** Send click to the `agent_end` frame. */
	uiTurnMs: number;
	/** UI-visible lag, separate from stream latency: delta frame arrival to DOM-visible. */
	renderLag: RenderLagStats;
	/** Wall clock to monotonic anchor quality, ns. */
	anchor: { offsetNs: bigint; spreadNs: bigint; driftNs: bigint };
	/** Processes seen in the browser tree at the end of the turn. */
	chromiumPids: number[];
	/** Affinity of the tree when `pinCpus` was set: the check after the turn (`repinned` marks drift Chromium caused itself). */
	affinity: AffinityRecord[];
	notes: string[];
}

function isProbeData(value: unknown): value is ProbeData {
	if (typeof value !== "object" || value === null) return false;
	return (
		"frames" in value &&
		typeof value.frames === "number" &&
		"deltas" in value &&
		Array.isArray(value.deltas) &&
		"clicks" in value &&
		Array.isArray(value.clicks) &&
		"renderLagMs" in value &&
		Array.isArray(value.renderLagMs)
	);
}

/**
 * Median `Date.now() * 1e6 - monotonicNs()` over `samples` sampled at millisecond
 * edges (spin until `Date.now()` ticks, then read the monotonic clock), so each
 * sample is exact to a few microseconds instead of +-0.5 ms.
 */
function sampleAnchor(samples: number): { offsets: bigint[] } {
	const offsets: bigint[] = [];
	for (let i = 0; i < samples; i++) {
		const start = Date.now();
		let now = start;
		while (now === start) now = Date.now();
		const mono = monotonicNs();
		offsets.push(BigInt(now) * NS_PER_MS - mono);
	}
	return { offsets };
}

function medianBig(xs: bigint[]): bigint {
	const sorted = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	return sorted[sorted.length >> 1]!;
}

function spreadBig(xs: bigint[]): bigint {
	let lo = xs[0]!;
	let hi = xs[0]!;
	for (const x of xs) {
		if (x < lo) lo = x;
		if (x > hi) hi = x;
	}
	return hi - lo;
}

/** Wall-clock ms (float, sub-ms) to integer ns without losing the fraction to double rounding. */
function wallMsToNs(ms: number): bigint {
	const whole = Math.floor(ms);
	return BigInt(whole) * NS_PER_MS + BigInt(Math.round((ms - whole) * 1e6));
}

async function sessionCwd(baseUrl: string, workspaceId: string): Promise<string> {
	const res = await fetch(`${baseUrl}/ctl/sessions`);
	if (!res.ok) throw new Error(`GET /ctl/sessions -> ${res.status}`);
	const rows: unknown = await res.json();
	if (!Array.isArray(rows)) throw new Error("/ctl/sessions did not return an array");
	for (const row of rows) {
		if (
			typeof row === "object" &&
			row !== null &&
			"workspaceId" in row &&
			row.workspaceId === workspaceId &&
			"cwd" in row &&
			typeof row.cwd === "string"
		) {
			return row.cwd;
		}
	}
	throw new Error(`session ${workspaceId} is not in the fleet roster`);
}

async function assertUiServed(baseUrl: string): Promise<void> {
	const res = await fetch(`${baseUrl}/`);
	const type = res.headers.get("content-type") ?? "";
	const body = await res.text();
	if (!res.ok || !type.includes("text/html")) {
		throw new Error(
			`fleet at ${baseUrl} does not serve the UI (GET / -> ${res.status} ${type}); run the fleet bare (no "control") so it serves dist/`,
		);
	}
	if (!body.includes('id="root"')) {
		throw new Error(
			`fleet at ${baseUrl} served the placeholder page; build the UI first: bun run build:web`,
		);
	}
}

function lagStats(probe: ProbeData): RenderLagStats {
	const lag = probe.renderLagMs;
	return {
		count: lag.length,
		pending: probe.renderPending,
		p50Ms: lag.length === 0 ? undefined : percentile(lag, 50),
		p95Ms: lag.length === 0 ? undefined : percentile(lag, 95),
		label:
			"delta frame arrival (page event) to its text being in the DOM at the next requestAnimationFrame; not paint-to-screen. Includes the UI's deliberate smooth-streaming reveal (display.smoothStreaming, default on: apps/web/store/chat.ts drains buffered deltas at a paced rate, at most about 0.4 s behind the last delta)",
	};
}

function clickLabelled(clicks: ProbeClick[], label: string): ProbeClick | undefined {
	return clicks.find((c) => c.target === label);
}

export async function runBrowserPass(opts: BrowserPassOptions): Promise<BrowserPassResult> {
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const notes: string[] = [];
	await assertUiServed(opts.baseUrl);
	const cwd = await sessionCwd(opts.baseUrl, opts.workspaceId);
	const found = await resolveChromium(opts.chromiumPath);
	if (found.rejected.length > 0) {
		notes.push(`skipped Chromium candidates: ${found.rejected.join("; ")}`);
	}
	if (Object.keys(found.env).length > 0) {
		notes.push(
			`chromium launched with ${Object.keys(found.env).join(", ")} for /nix/store libraries`,
		);
	}
	const scratch = mkdtempSync(join(tmpdir(), "profile-chromium-"));
	const before = launchedRoots();
	let rootPid: number | undefined;
	let userDataDir: string | undefined;
	const seenPids = new Set<number>();
	// Last resort on abrupt exit: Playwright's own signal handling is off so the
	// runner stays in charge of SIGINT; make sure the tree dies with this process.
	const onExit = (): void => {
		for (const pid of seenPids) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
	};
	process.on("exit", onExit);
	// Chromium's gpu process (SwiftShader) sets its own worker-thread affinity, so a
	// pinned launch is not enough: verify and repin right before measuring and after.
	const checkPins = async (root: number): Promise<AffinityRecord[]> =>
		opts.pinCpus === undefined ? [] : ensureAffinity("chromium", chromiumPins(root), opts.pinCpus);
	let browserHandle: Awaited<ReturnType<typeof playwright.launch>> | undefined;
	try {
		const launchEnv: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined) launchEnv[k] = v;
		Object.assign(launchEnv, found.env);
		const browser = await playwright.launch({
			executablePath: launchExecutable(found, scratch, opts.pinCpus),
			headless: opts.headless,
			args: BROWSER_ARGS,
			env: launchEnv,
			timeout: 30_000,
			handleSIGINT: false,
			handleSIGTERM: false,
			handleSIGHUP: false,
		});
		browserHandle = browser;
		rootPid = findLaunchedRoot(before);
		if (rootPid === undefined) throw new Error("could not find the launched Chromium root pid");
		userDataDir = userDataDirOf(rootPid);
		for (const pid of chromiumPins(rootPid)) seenPids.add(pid);
		await opts.onLaunch?.(rootPid);

		const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
		const probeConfig: ProbeConfig = { workspaceId: opts.workspaceId, key: PROBE_KEY };
		await context.addInitScript(installProbe, probeConfig);
		const page = await context.newPage();
		const pageErrors: string[] = [];
		page.on("pageerror", (err) => pageErrors.push(err.message));
		await page.goto(opts.baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

		const row = page.locator(`.roster-row-title[title=${JSON.stringify(cwd)}]`);
		await row.waitFor({ state: "visible", timeout: timeoutMs });
		for (const pid of chromiumPins(rootPid)) seenPids.add(pid);
		await opts.onPageReady?.(rootPid);
		await checkPins(rootPid);

		const anchorBefore = sampleAnchor(ANCHOR_SAMPLES).offsets;
		await row.click({ timeout: timeoutMs });
		const waitProbe = (field: keyof ProbeData, what: string): Promise<unknown> =>
			page
				.waitForFunction(
					([key, name]) => Reflect.get(Reflect.get(window, key), name) !== undefined,
					[PROBE_KEY, field] as const,
					{ timeout: timeoutMs, polling: 20 },
				)
				.catch((err: unknown) => {
					throw new Error(
						`timed out waiting for ${what}: ${err instanceof Error ? err.message : String(err)}${pageErrors.length > 0 ? ` (page errors: ${pageErrors.join(" | ")})` : ""}`,
					);
				});
		await waitProbe("primedAtWallMs", "attach priming (available_commands after history)");

		const composer = page.locator(COMPOSER);
		await composer.waitFor({ state: "visible", timeout: timeoutMs });
		// fill, not type: the directive prompt has a newline, and Enter submits.
		await composer.fill(opts.directivePrompt);
		const send = page.locator(SEND);
		await send.waitFor({ state: "visible", timeout: timeoutMs });
		await page.waitForSelector(`${SEND}:not([disabled])`, { timeout: timeoutMs });
		await checkPins(rootPid);
		await send.click({ timeout: timeoutMs });

		await waitProbe("agentEndAtWallMs", "agent_end");
		try {
			await page.waitForFunction(
				(key) => Reflect.get(Reflect.get(window, key), "renderPending") === 0,
				PROBE_KEY,
				{ timeout: 10_000, polling: 50 },
			);
		} catch {
			notes.push(
				"DOM did not show every delta within 10 s of agent_end (see renderPending and the shown/received char counts below)",
			);
		}
		const pre: unknown = await page.evaluate((key) => Reflect.get(window, key), PROBE_KEY);
		if (isProbeData(pre) && pre.renderPending > 0) {
			notes.push(
				`render: DOM showed ${pre.shownChars} of ${pre.deltaChars} received non-whitespace chars`,
			);
		}
		await page
			.waitForSelector("button.stop", { state: "detached", timeout: 5_000 })
			.catch(() => notes.push("Stop button still present 5 s after agent_end"));
		for (const pid of chromiumPins(rootPid)) seenPids.add(pid);
		const pids = chromiumPins(rootPid);
		const affinity = await checkPins(rootPid);
		const drifted = affinity.filter((r) => r.repinned || !r.ok);
		if (drifted.length > 0) {
			notes.push(
				`chromium affinity drifted during the turn for pids ${drifted.map((r) => r.pid).join(", ")}`,
			);
		}

		const raw: unknown = await page.evaluate((key) => Reflect.get(window, key), PROBE_KEY);
		if (!isProbeData(raw)) throw new Error("probe data missing or malformed in the page");
		const probe = raw;
		const anchorAfter = sampleAnchor(ANCHOR_SAMPLES).offsets;
		const offsetNs = medianBig([...anchorBefore, ...anchorAfter]);
		const driftNs = medianBig(anchorAfter) - medianBig(anchorBefore);
		const anchor = {
			offsetNs,
			spreadNs: spreadBig([...anchorBefore, ...anchorAfter]),
			driftNs,
		};

		const rowClick = probe.clicks.find((c) => c.target !== "Send");
		const submit = clickLabelled(probe.clicks, "Send");
		if (rowClick === undefined || submit === undefined) {
			throw new Error(
				`expected a roster click and a Send click, saw ${JSON.stringify(probe.clicks)}`,
			);
		}
		if (
			probe.attachedAtWallMs === undefined ||
			probe.primedAtWallMs === undefined ||
			probe.agentEndAtWallMs === undefined
		) {
			throw new Error("probe is missing attached/primed/agent_end stamps");
		}
		const recv: RecvRecord[] = probe.deltas.map((d) => ({
			route: opts.route,
			req: d.req,
			contentIndex: d.contentIndex,
			offset: d.offset,
			recvNs: wallMsToNs(d.recvWallMs) - offsetNs,
		}));
		await opts.flushSendLog?.();
		const joined = joinLatency(opts.sendLog, recv);

		const skew = probe.wallSkewMs;
		if (skew.length > 0) {
			notes.push(
				`in-page Date.now() minus timeOrigin+performance.now(): median ${median(skew).toFixed(3)} ms over ${skew.length} frames`,
			);
		}
		notes.push(
			`wall to monotonic anchor: ${anchor.spreadNs / 1000n} us spread, ${anchor.driftNs / 1000n} us drift across the pass`,
		);
		if (found.source !== "playwright-cache") notes.push(`Chromium source: ${found.source}`);
		if (pageErrors.length > 0) notes.push(`page errors: ${pageErrors.join(" | ")}`);
		const rendered =
			probe.firstRenderedAtWallMs === undefined
				? undefined
				: probe.firstRenderedAtWallMs - submit.atWallMs;

		return {
			browser: {
				name: found.name,
				version: browser.version(),
				path: found.path,
				headless: opts.headless,
				source: found.source,
				rootPid,
			},
			clock: "chromium-wall-clock",
			ttffMs: probe.attachedAtWallMs - rowClick.atWallMs,
			primedMs: probe.primedAtWallMs - rowClick.atWallMs,
			renderedFirstDeltaMs: rendered,
			firstDeltaMs:
				probe.firstDeltaAtWallMs === undefined
					? undefined
					: probe.firstDeltaAtWallMs - submit.atWallMs,
			latencyNs: joined.ns,
			unmatched: joined.unmatched,
			framesReceived: probe.frames,
			deltaFrames: probe.deltaFrames,
			uiTurnMs: probe.agentEndAtWallMs - submit.atWallMs,
			renderLag: lagStats(probe),
			anchor,
			chromiumPids: pids,
			affinity,
			notes,
		};
	} finally {
		process.off("exit", onExit);
		if (browserHandle !== undefined) {
			await Promise.race([browserHandle.close().catch(() => undefined), Bun.sleep(5_000)]);
		}
		if (rootPid !== undefined) {
			await killChromiumTree(rootPid, userDataDir, seenPids);
		}
		rmSync(scratch, { recursive: true, force: true });
	}
}
