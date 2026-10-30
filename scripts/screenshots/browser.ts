/**
 * Browser plumbing for the screenshot script: the static demo build, a loopback
 * server for it, Chromium launch, and the deterministic page recipe (fresh
 * context per shot, fixed clock, fixed locale and zone, reduced motion, theme
 * through localStorage, demo chrome hidden, fonts settled).
 *
 * The demo build is the one `bun run build:demo` writes: it serves the App at
 * `/` and any story alone at `/?embed=<storyId>`, with fixture data and the fake
 * session running in the page, so no fleet is needed.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	chromium,
	devices,
	type Browser,
	type BrowserContext,
	type Locator,
	type Page,
} from "playwright-core";
import { resolveChromium } from "../profile/browser/chromium";
import type { AppStep, Scheme, Viewport } from "./scenes";

/** Same instant as apps/design-system/fixtures/session.ts FIXTURE_NOW, so relative times match the fixtures. */
export const FIXTURE_NOW = Date.parse("2026-10-09T12:00:00Z");

export const DEFAULT_THEME = "catppuccin";

/** Upper bound for one wait; a miss means the page is broken, not slow. */
const WAIT_MS = 20_000;

/**
 * Whole-tile raster only. With partial raster Chromium repaints just the dirty rectangle of a tile when
 * part of the page changes, and whether a fractionally positioned rounded border (the activity chips sit
 * on half pixels) was drawn by the first full raster or by a later partial one depends on real-time
 * scheduling: the anti-aliased corner pixels differ by one level between runs, and an animation's
 * decoded frames then differ between processes.
 */
const CHROMIUM_ARGS = ["--disable-partial-raster"];

export interface Env {
	browser: Browser;
	base: string;
	stop(): Promise<void>;
}

/** Build the demo into `dir` (bun apps/design-system/build.ts), serve it on a free loopback port and launch Chromium. */
export async function startEnv(repoRoot: string, dir: string): Promise<Env> {
	mkdirSync(dir, { recursive: true });
	const build = Bun.spawn(["bun", join(repoRoot, "apps/design-system/build.ts"), dir], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, code] = await Promise.all([new Response(build.stderr).text(), build.exited]);
	if (code !== 0) throw new Error(`demo build failed:\n${stderr.trim()}`);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			const file = Bun.file(join(dir, pathname === "/" ? "index.html" : pathname));
			// Static assets only; `..` cannot appear in a normalised URL path.
			return (await file.exists())
				? new Response(file)
				: new Response("not found", { status: 404 });
		},
	});
	let found;
	try {
		found = await resolveChromium();
	} catch (err) {
		await server.stop(true);
		throw new Error(
			`${err instanceof Error ? err.message : String(err)}\nInstall the pinned browser with: bunx playwright install chromium-headless-shell`,
		);
	}
	const browser = await chromium.launch({
		executablePath: found.path,
		args: CHROMIUM_ARGS,
		env: { ...process.env, ...found.env } as Record<string, string>,
	});
	return {
		browser,
		base: `http://127.0.0.1:${server.port}/`,
		async stop() {
			await browser.close();
			await server.stop(true);
		},
	};
}

export interface ThemeChoice {
	/** Theme id for both schemes (built-in ids, e.g. `catppuccin`). */
	id: string;
	scheme: Scheme;
}

export interface ContextOptions {
	viewport: Viewport;
	scale: number;
	/** A handset: touch input and a mobile user agent, so hover-only controls behave as on a phone. */
	touch?: boolean;
	/** A Playwright device descriptor (`devices` key, e.g. `Pixel 7`): its user agent, touch and mobile flags; `viewport` and `scale` still decide the size. */
	device?: string;
	theme: ThemeChoice;
}

/** A fresh context: nothing leaks between shots (storage, clock, caches). */
export async function newContext(env: Env, opts: ContextOptions): Promise<BrowserContext> {
	const descriptor = opts.device === undefined ? undefined : devices[opts.device];
	if (opts.device !== undefined && descriptor === undefined)
		throw new Error(`unknown Playwright device: ${opts.device}`);
	const ctx = await env.browser.newContext({
		...descriptor,
		viewport: opts.viewport,
		deviceScaleFactor: opts.scale,
		timezoneId: "UTC",
		locale: "en-US",
		reducedMotion: "reduce",
		colorScheme: opts.theme.scheme,
		hasTouch: opts.touch === true || descriptor?.hasTouch === true,
		isMobile: opts.touch === true || descriptor?.isMobile === true,
	});
	ctx.setDefaultTimeout(WAIT_MS);
	// The App reads these keys before first paint (apps/design-system/index.html, apps/web/index.html).
	await ctx.addInitScript(
		({ mode, id }) => {
			localStorage.setItem("omp-web:theme-mode", mode);
			localStorage.setItem("omp-web:theme-light", id);
			localStorage.setItem("omp-web:theme-dark", id);
		},
		{ mode: opts.theme.scheme, id: opts.theme.id },
	);
	return ctx;
}

/**
 * Open `url` under the recipe and wait until the page is settled: the requested
 * theme variant applied and web fonts loaded. `clock` is fixed before navigation
 * (`fixed`: Date frozen, timers run; `paused`: the whole clock held at FIXTURE_NOW + 1s, the
 * caller steps it with `page.clock.runFor`).
 */
export async function openPage(
	ctx: BrowserContext,
	url: string,
	theme: ThemeChoice,
	clock: "fixed" | "paused",
): Promise<Page> {
	const page = await ctx.newPage();
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(err.message));
	if (clock === "fixed") {
		await page.clock.setFixedTime(FIXTURE_NOW);
	} else {
		await page.clock.install({ time: FIXTURE_NOW });
		await page.clock.pauseAt(new Date(FIXTURE_NOW + 1000));
		// The installed clock runs in real time until pauseAt, so the paused tick count starts at however
		// many milliseconds that took. Fake animation frames fire on a 16-tick grid, so that start decides
		// how frames interleave with timers. A probe document (a same-origin 404, so the theme init script
		// can reach localStorage and no app code runs) replays the clock log the page will replay, so its
		// tick count is the page's; step it onto the grid before the page loads.
		await page.goto(new URL("clock-probe", url).href);
		const ticks = await page.evaluate(() => performance.now());
		const offGrid = Math.ceil(ticks) % 16;
		if (offGrid !== 0) await page.clock.runFor(16 - offGrid);
	}
	await page.goto(url);
	await page.addStyleTag({ content: ".ds-demo-note-host{display:none}" });
	await ensureTheme(page, theme);
	// Every declared face, not only those in use: a subset fetched lazily when new text first needs it
	// (a streamed glyph, a dock opening later) lands on a real-time schedule and flips frames between runs.
	await page.evaluate(() =>
		Promise.all([...document.fonts].map((face) => face.load())).then(() => document.fonts.ready),
	);
	if (errors.length > 0) throw new Error(`page error at ${url}: ${errors[0]}`);
	return page;
}

/**
 * Make the page show `theme`. The init script stores it before first paint, but a story seed may
 * store another mode (the theme stories seed dark), so a mismatch is corrected the way the
 * embedded story follows its inspector: rewrite the stored mode and fire `storage`, which the
 * page re-reads. Waits for the variant attribute, never a timeout.
 */
export async function ensureTheme(page: Page, theme: ThemeChoice): Promise<void> {
	const variant = `${theme.id}/${theme.scheme}`;
	const key = "omp-web:theme-mode";
	await page.evaluate(
		({ key, scheme, variant }) => {
			if (document.documentElement.dataset.themeVariant === variant) return;
			localStorage.setItem(key, scheme);
			window.dispatchEvent(new StorageEvent("storage", { key }));
		},
		{ key, scheme: theme.scheme, variant },
	);
	await page.waitForSelector(`html[data-theme-variant="${variant}"]`, { state: "attached" });
}

/** Two animation frames: layout and paint have caught up with the last DOM change. Not under a paused clock (it fakes rAF). */
export async function settle(page: Page): Promise<void> {
	await page.evaluate(() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
		return promise;
	});
}

/** No DOM change for this long means late data (stats, lists) has landed; real time, stills only. */
const QUIET_MS = 400;
/** A page that keeps changing this long is animating by script; the shot would not be reproducible. */
const QUIET_LIMIT_MS = 15_000;

/**
 * Resolve once the document has stopped changing for `QUIET_MS`. Selector waits cover what a shot is about;
 * this covers what arrives after them (a subagent's token totals, a list's second page). Throws when the
 * page never quiets. Not under a paused clock.
 */
export async function quiet(page: Page): Promise<void> {
	const settled = await page.evaluate(
		({ quietMs, limitMs }) => {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			let timer = setTimeout(() => done(true), quietMs);
			const limit = setTimeout(() => done(false), limitMs);
			const observer = new MutationObserver(() => {
				clearTimeout(timer);
				timer = setTimeout(() => done(true), quietMs);
			});
			function done(ok: boolean): void {
				observer.disconnect();
				clearTimeout(timer);
				clearTimeout(limit);
				resolve(ok);
			}
			observer.observe(document, {
				subtree: true,
				childList: true,
				attributes: true,
				characterData: true,
			});
			return promise;
		},
		{ quietMs: QUIET_MS, limitMs: QUIET_LIMIT_MS },
	);
	if (!settled) throw new Error("the page never stopped changing");
}

/** The first visible match of `selector` (hidden twins, such as the other stacked story variants, are skipped). */
export function visible(page: Page, selector: string): Locator {
	return page.locator(`${selector} >> visible=true`).first();
}

/** Run the declarative steps of a scene. */
export async function runSteps(page: Page, steps: readonly AppStep[]): Promise<void> {
	for (const step of steps) {
		if ("wait" in step) await visible(page, step.wait).waitFor();
		else if ("click" in step) await visible(page, step.click).click();
		else if ("press" in step) await page.keyboard.press(step.press);
		else if ("fill" in step) await visible(page, step.fill).fill(step.text);
		else if ("type" in step) await visible(page, step.type).pressSequentially(step.text);
		else if ("hover" in step) await visible(page, step.hover).hover();
		else if ("gone" in step) await page.locator(step.gone).first().waitFor({ state: "detached" });
		await settle(page);
	}
}
