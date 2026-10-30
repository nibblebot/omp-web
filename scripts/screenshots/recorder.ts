/**
 * The frame recorder behind the animated shots (hero.ts, hero-phone.ts). The page clock is installed
 * and paused before navigation (browser.ts `openPage(..., "paused")`), so the page only moves when the
 * recorder runs it forward (`clock.runFor`): every timer, stream chunk and transition lands on the
 * same frame in every run. Real input (typing, clicks, taps) is delivered between ticks.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { visible } from "./browser";
import { HERO_FPS } from "./media";

export const FRAME_MS = 1000 / HERO_FPS;
/** Seed of the typing rhythm: fixed, so every run types the same keys at the same fake instants. */
const TYPING_SEED = 0x6f6d70;
/** Pause between focusing the composer and the first key. */
const PAUSE_BEFORE_TYPING_MS = 320;
/** Fake milliseconds per clock step: small, so chains that settle on the real task queue land on the same step every run. */
const STEP_MS = 5;
/** Clock steps spent waiting for a selector before the first frame; each is 50 fake ms. */
const MAX_WAIT_TICKS = 400;

export interface Recorder {
	page: Page;
	dir: string;
	count: number;
}

/** A recorder writing `dir/f001.png ...` for `page`. */
export function createRecorder(page: Page, dir: string): Recorder {
	mkdirSync(dir, { recursive: true });
	return { page, dir, count: 0 };
}

/** Move the page clock forward `ms`, in steps with the real task queue drained after each. */
async function advance(page: Page, ms: number): Promise<void> {
	for (let left = ms; left > 0; left -= STEP_MS) {
		await page.clock.runFor(Math.min(STEP_MS, left));
		await flushTasks(page);
	}
}

/** Keep the PNG of the page as it is now. */
async function shoot(rec: Recorder): Promise<void> {
	const name = `f${String(++rec.count).padStart(3, "0")}.png`;
	await rec.page.screenshot({ path: join(rec.dir, name), animations: "disabled" });
}

/** Advance the page one frame and keep the PNG. */
async function frame(rec: Recorder): Promise<void> {
	await advance(rec.page, FRAME_MS);
	await shoot(rec);
}

/** Input delivered `at` fake milliseconds into a span of frames. */
export interface Cue {
	at: number;
	run: () => Promise<unknown>;
}

/**
 * Record the frames that cover `cues`: each one is delivered at its own instant inside the frame it
 * falls in (the clock stops there, the page drains, the clock goes on), so input is not quantised to
 * the frame rate. Ends on the frame boundary after the last cue.
 */
export async function frameCues(rec: Recorder, cues: readonly Cue[]): Promise<void> {
	let elapsed = 0;
	let next = 0;
	for (let end = FRAME_MS; next < cues.length; end += FRAME_MS) {
		for (; next < cues.length && cues[next]!.at < end; next++) {
			const cue = cues[next]!;
			await advance(rec.page, cue.at - elapsed);
			elapsed = cue.at;
			await act(rec.page, cue.run);
		}
		await advance(rec.page, end - elapsed);
		elapsed = end;
		await shoot(rec);
	}
}

/**
 * The paused clock fakes timers and animation frames, not the real task queue: Solid's scheduler and
 * promise chains still settle on it, and how many hops a chain takes varies with load. Round-trip real
 * tasks until several in a row change nothing in the DOM, so the page has finished reacting to the last
 * clock step (and to typed input) before the clock moves again or the pixels are read.
 */
async function flushTasks(page: Page): Promise<void> {
	const settled = await page.evaluate(async () => {
		const observer = new MutationObserver(() => {});
		observer.observe(document, {
			subtree: true,
			childList: true,
			attributes: true,
			characterData: true,
		});
		let clean = 0;
		for (let hop = 0; hop < 500 && clean < 4; hop++) {
			const { promise, resolve } = Promise.withResolvers<void>();
			const channel = new MessageChannel();
			channel.port1.onmessage = () => resolve();
			channel.port2.postMessage(0);
			await promise;
			clean = observer.takeRecords().length === 0 ? clean + 1 : 0;
		}
		observer.disconnect();
		return clean >= 4;
	});
	if (!settled) throw new Error("recorder: the page kept changing without the clock moving");
}

/** Record `n` frames. */
export async function frames(rec: Recorder, n: number): Promise<void> {
	for (let i = 0; i < n; i++) await frame(rec);
}

/** Record frames until `selector` is visible (at most `max`): the wait is part of the recording. */
export async function framesUntil(rec: Recorder, selector: string, max: number): Promise<void> {
	for (let n = 0; !(await visible(rec.page, selector).isVisible()); n++) {
		if (n >= max) throw new Error(`recorder: ${selector} never appeared`);
		await frame(rec);
	}
}

/** Record frames until `done()` holds (at most `max`); `what` names the wait in the error. */
export async function framesWhile(
	rec: Recorder,
	done: () => Promise<boolean>,
	max: number,
	what: string,
): Promise<void> {
	for (let n = 0; !(await done()); n++) {
		if (n >= max) throw new Error(`recorder: ${what}`);
		await frame(rec);
	}
}

/** A small seeded PRNG (mulberry32): the same sequence on every run, unlike Math.random. */
function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * One keystroke per character, a human gap before each: 40 to 110 ms, longer after a space or a comma,
 * and a beat before an `@`. The gaps come from a seeded generator, so the rhythm is the same on every
 * run. The first key is `PAUSE_BEFORE_TYPING_MS` after the span starts.
 */
export function keystrokes(page: Page, text: string): Cue[] {
	const random = seeded(TYPING_SEED);
	const cues: Cue[] = [];
	let at = PAUSE_BEFORE_TYPING_MS;
	let previous = "";
	for (const char of text) {
		if (cues.length > 0) {
			let gap = 40 + random() * 70;
			if (previous === " ") gap += 20 + random() * 30;
			if (previous === ",") gap += 120;
			if (char === "@") gap += 360;
			at += Math.round(gap / STEP_MS) * STEP_MS; // on the clock step, so every cue lands on a step boundary
		}
		cues.push({ at, run: () => page.keyboard.type(char) });
		previous = char;
	}
	return cues;
}

/**
 * Run the page clock in fixed steps until `selector` is visible (no frames kept): the paused clock never
 * advances on its own. Every step is followed by a flush, so the number of steps depends on the page's
 * fake-time behaviour only.
 */
export async function until(page: Page, selector: string): Promise<void> {
	for (let tick = 0; tick < MAX_WAIT_TICKS; tick++) {
		if (await visible(page, selector).isVisible()) return;
		await page.clock.runFor(50);
		await flushTasks(page);
	}
	throw new Error(`recorder: ${selector} never appeared`);
}

/**
 * Deliver real input between clock steps. The page reacts to it through promises that settle on the
 * real task queue; they are drained before the clock moves again, or a timer they schedule would start
 * at whatever fake instant the next step happened to be in.
 */
export async function act(page: Page, input: () => Promise<unknown>): Promise<void> {
	await input();
	await flushTasks(page);
}
