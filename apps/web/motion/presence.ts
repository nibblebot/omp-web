/**
 * Motion helpers: wait for an element's own CSS motion to finish, and keep
 * content mounted through its exit motion.
 *
 * CSS convention: the animated element carries `data-motion={phase()}`;
 * `[data-motion="enter"]` and `[data-motion="exit"]` hold the hidden state, the
 * base rule holds the shown state, and the transition lives on the base rule
 * (durations come from the `--dur-*` tokens in styles/tokens.css, so reduced
 * motion shortens them without any logic here).
 */
import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";

export type PresencePhase = "enter" | "open" | "exit";

/** Slack added to the computed duration before the fallback timer gives up on an end event. */
const FALLBACK_SLACK_MS = 50;

/** CSS <time> list ("0.2s, 140ms") to milliseconds. */
function parseTimes(value: string): number[] {
	return value.split(",").map((part) => {
		const text = part.trim();
		const n = Number.parseFloat(text);
		if (Number.isNaN(n)) return 0;
		return text.endsWith("ms") ? n : n * 1000;
	});
}

/** The comma-separated list item for index `i`; shorter lists repeat (CSS list matching). */
function at<T>(list: readonly T[], i: number, fallback: T): T {
	return list.length === 0 ? fallback : (list[i % list.length] as T);
}

/**
 * Longest finite end time (delay + duration, times iteration count for
 * animations) over the element's own transitions and animations, in ms.
 * Infinite animations never end, so they are not waited on.
 */
function maxMotionMs(el: Element): number {
	const cs = getComputedStyle(el);
	let max = 0;

	const properties = cs.transitionProperty.split(",");
	const tDur = parseTimes(cs.transitionDuration);
	const tDelay = parseTimes(cs.transitionDelay);
	for (let i = 0; i < properties.length; i++) {
		if (properties[i]?.trim() === "none") continue;
		const dur = at(tDur, i, 0);
		if (dur <= 0) continue;
		max = Math.max(max, dur + Math.max(0, at(tDelay, i, 0)));
	}

	const names = cs.animationName.split(",");
	const aDur = parseTimes(cs.animationDuration);
	const aDelay = parseTimes(cs.animationDelay);
	const counts = cs.animationIterationCount.split(",");
	for (let i = 0; i < names.length; i++) {
		if (names[i]?.trim() === "none") continue;
		const dur = at(aDur, i, 0);
		if (dur <= 0) continue;
		const rawCount = at(counts, i, "1").trim();
		if (rawCount === "infinite") continue;
		const count = Number.parseFloat(rawCount);
		max = Math.max(max, Math.max(0, at(aDelay, i, 0)) + dur * (Number.isNaN(count) ? 1 : count));
	}
	return max;
}

/**
 * Calls `done` once `el`'s own transitions/animations finish, or after the
 * fallback timer; calls it synchronously when there is nothing to wait for.
 * Returns a canceller that clears the listeners and timer without calling `done`.
 */
function watchMotion(el: Element, done: () => void): () => void {
	const max = el.isConnected ? maxMotionMs(el) : 0;
	if (max <= 0) {
		done();
		return () => {};
	}

	function cancel() {
		clearTimeout(timer);
		el.removeEventListener("transitionend", onEnd);
		el.removeEventListener("animationend", onEnd);
	}
	function finish() {
		cancel();
		done();
	}
	function onEnd(ev: Event) {
		// Bubbled events from descendants are not this element's motion.
		if (ev.target !== el) return;
		// Properties with different durations end separately: wait for the last
		// one still running (infinite animations never end and do not count).
		const live = el
			.getAnimations?.()
			.some(
				(a) =>
					(a.pending || a.playState === "running") &&
					Number.isFinite(a.effect?.getComputedTiming().endTime),
			);
		if (live) return;
		finish();
	}
	el.addEventListener("transitionend", onEnd);
	el.addEventListener("animationend", onEnd);
	const timer = setTimeout(finish, max + FALLBACK_SLACK_MS);
	return cancel;
}

/**
 * Resolves when `el`'s own transitions/animations finish (transitionend /
 * animationend with target === el), or after the longest computed
 * duration + delay plus 50ms as a fallback (an end event never fires when
 * nothing actually changed). Resolves immediately when that maximum is 0 or
 * `el` is not rendered.
 */
export function afterMotion(el: Element): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	watchMotion(el, resolve);
	return promise;
}

/**
 * Keeps content mounted through its exit motion. `mounted()` turns true when
 * `open()` does; `phase()` is "enter" for the first frame after mount (the CSS
 * initial state), then "open". When `open()` goes false `phase()` is "exit" and
 * `mounted()` stays true until `afterMotion` of the `ref` element resolves.
 * Reopening during exit returns to "open" without remounting (the CSS
 * transition reverses from where it is); closing during enter goes to "exit".
 *
 * An `open()` that is already true at creation also plays the enter motion; a
 * closed one starts unmounted in phase "exit" (the hidden state).
 */
export function createPresence(open: Accessor<boolean>): {
	mounted: Accessor<boolean>;
	phase: Accessor<PresencePhase>;
	ref: (el: HTMLElement) => void;
} {
	const [mounted, setMounted] = createSignal(open());
	const [phase, setPhase] = createSignal<PresencePhase>(open() ? "enter" : "exit");
	let el: HTMLElement | undefined;
	let frame = 0;
	let cancelWatch: (() => void) | undefined;
	// Invalidates microtasks/frames queued by a superseded open() change.
	let generation = 0;

	const cancelPending = () => {
		generation++;
		if (frame !== 0) cancelAnimationFrame(frame);
		frame = 0;
		cancelWatch?.();
		cancelWatch = undefined;
	};

	createEffect(
		on(open, (isOpen) => {
			cancelPending();
			if (isOpen) {
				if (mounted() && phase() === "exit") {
					setPhase("open");
					return;
				}
				setMounted(true);
				setPhase("enter");
				// Two frames: the first paints the hidden state, the second flips it so
				// the transition has a starting style to run from.
				const gen = generation;
				frame = requestAnimationFrame(() => {
					frame = requestAnimationFrame(() => {
						frame = 0;
						if (gen === generation) setPhase("open");
					});
				});
				return;
			}
			if (!mounted()) return;
			setPhase("exit");
			// After Solid flushes data-motion="exit" to the DOM.
			const gen = generation;
			queueMicrotask(() => {
				if (gen !== generation) return;
				if (!el) {
					setMounted(false);
					return;
				}
				cancelWatch = watchMotion(el, () => {
					cancelWatch = undefined;
					setMounted(false);
				});
			});
		}),
	);

	onCleanup(cancelPending);

	return {
		mounted,
		phase,
		ref: (node) => {
			el = node;
		},
	};
}
