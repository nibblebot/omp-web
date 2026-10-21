import { createEffect, createSignal, on, onCleanup, type Accessor } from "solid-js";
import { afterMotion } from "../../../motion/presence";
import { cloneVisible } from "./clone-visible";
import { isSwitching, setPromptFocusRequest, state } from "../../../state";

/** How long a switch may stay unloaded before the skeleton appears. */
export const SKELETON_DELAY_MS = 250;
/** Once shown, the skeleton stays at least this long (no flash of a skeleton). */
export const SKELETON_MIN_MS = 300;

/**
 * What the transcript body is doing, as `data-motion` on `.chat-transcript-body`:
 * - `open`: shown;
 * - `enter`: hidden in the fade-in's start pose (6px down). It is held from the moment
 *   a switch starts, while a snapshot of the old content fades out over it, until the
 *   new content is loaded and the snapshot is gone; then it opens at once.
 */
export type BodyMotion = "enter" | "open";

/**
 * Holds the chat pane mounted while a vanished session fades out (see App.tsx),
 * so its idle pane swap does not cut the fade short.
 */
export const [transcriptExiting, setTranscriptExiting] = createSignal(false);

/** What the phase asks of the view: nothing, or one switch (keyed by its target). */
function transitionKey(): string {
	const phase = state.transcriptPhase;
	if (phase === "failed") return `failed:${state.transcriptTarget}`;
	if (isSwitching()) return `busy:${state.transcriptTarget}`;
	return "ready";
}

/** The elements the transition works on (refs, assigned once the view renders). */
export interface TranscriptElements {
	view: () => HTMLElement | undefined;
	body: () => HTMLElement | undefined;
}

/**
 * Drives the out/in transition of a session switch from `state.transcriptPhase`.
 *
 * When a switch starts, a snapshot of the old content (a deep clone, inert and
 * aria-hidden, without ids, at the same scroll position) fades out over `--dur-fast`
 * on top of the view while the live body is hidden at once, so the store can swap
 * the session underneath without the old or the new content showing through the
 * fade. The new content enters (fade plus a 6px rise) only when the phase is
 * loaded AND the snapshot is gone. The skeleton appears only if the switch is still
 * unloaded after SKELETON_DELAY_MS and then stays for at least SKELETON_MIN_MS.
 * Entering also hands the composer focus. Every timer is keyed to a generation
 * that a newer phase change bumps, so a superseded switch never fires anything.
 *
 * A vanished session (phase loaded to idle with the session still set) gets the
 * same snapshot fade, and holds the chat pane mounted until it ends.
 *
 * A re-attach of the attached daemon never changes the phase, so it has no
 * transition at all.
 */
export function useTranscriptTransition(els: TranscriptElements): {
	motion: Accessor<BodyMotion>;
	skeletonOpen: Accessor<boolean>;
} {
	const [motion, setMotion] = createSignal<BodyMotion>(isSwitching() ? "enter" : "open");
	const [skeletonOpen, setSkeletonOpen] = createSignal(false);
	let generation = 0;
	let timer: number | undefined;
	let skeletonShownAt = 0;
	/** The phase is loaded (or idle) again after a switch and the view should enter. */
	let ready = false;
	/** No snapshot is still fading out. */
	let snapshotDone = true;
	const snapshots = new Set<HTMLElement>();
	const cancelPending = () => {
		generation++;
		clearTimeout(timer);
		timer = undefined;
	};
	/**
	 * Fade a copy of what is on screen out over it (only the visible items are
	 * cloned, see cloneVisible). Resolves when it is gone; null when there is
	 * nothing on screen to copy.
	 */
	const snapshot = (): Promise<void> | null => {
		const view = els.view();
		const body = els.body();
		if (!view || !body || body.childElementCount === 0 || motion() !== "open") return null;
		const copy = cloneVisible(body);
		copy.classList.add("chat-transcript-ghost");
		copy.removeAttribute("data-motion");
		copy.removeAttribute("id");
		// Never duplicate an id, take focus or input, or be read out.
		for (const el of copy.querySelectorAll("[id]")) el.removeAttribute("id");
		copy.setAttribute("aria-hidden", "true");
		copy.setAttribute("inert", "");
		view.append(copy);
		const liveScroller = body.querySelector(".chat-transcript");
		const copyScroller = copy.querySelector(".chat-transcript");
		if (liveScroller && copyScroller) {
			// Reading it back forces layout; a first assignment can clamp before the
			// cloned items have their final heights, so assign again once it settled.
			copyScroller.scrollTop = liveScroller.scrollTop;
			if (copyScroller.scrollTop !== liveScroller.scrollTop)
				copyScroller.scrollTop = liveScroller.scrollTop;
		}
		snapshots.add(copy);
		return afterMotion(copy).then(() => {
			copy.remove();
			snapshots.delete(copy);
		});
	};

	const enter = (gen: number) => {
		if (gen !== generation) return;
		setSkeletonOpen(false);
		// The body has sat in its hidden pose since the switch began; reading its
		// style makes sure that pose is the transition's starting point, so it can
		// open in this very tick (no frame of blank pane after the snapshot is gone).
		const body = els.body();
		if (body) void getComputedStyle(body).opacity;
		setMotion("open");
		setPromptFocusRequest(true);
	};

	/** Enter once loaded, after the snapshot is gone and the skeleton's minimum is served. */
	const tryEnter = () => {
		if (!ready || !snapshotDone) return;
		const gen = generation;
		const remaining = skeletonOpen() ? skeletonShownAt + SKELETON_MIN_MS - Date.now() : 0;
		if (remaining > 0) timer = window.setTimeout(() => enter(gen), remaining);
		else enter(gen);
	};

	createEffect(
		on(transitionKey, (key, prev) => {
			cancelPending();
			ready = key === "ready";
			if (ready) {
				// Loaded (or idle) again after a switch; without one, nothing to do.
				if (prev !== undefined && prev !== "ready") tryEnter();
				return;
			}
			setSkeletonOpen(false);
			if (prev === undefined || prev === "ready") {
				// A switch starts: snapshot the old content and hide the live body.
				const fading = snapshot();
				setMotion("enter");
				snapshotDone = fading === null;
				void fading?.then(() => {
					snapshotDone = true;
					tryEnter();
				});
			}
			if (key.startsWith("busy:")) {
				timer = window.setTimeout(() => {
					skeletonShownAt = Date.now();
					setSkeletonOpen(true);
				}, SKELETON_DELAY_MS);
			}
		}),
	);

	// A selected session that vanishes (its worktree was removed) empties the store
	// in the tick the phase goes idle; fade the snapshot instead of cutting.
	createEffect(
		on(
			() => state.transcriptPhase,
			(phase, prev) => {
				if (phase !== "idle" || prev !== "loaded" || state.currentSessionId === "") return;
				const fading = snapshot();
				if (fading === null) return;
				setTranscriptExiting(true);
				void fading.then(() => setTranscriptExiting(false));
			},
		),
	);

	onCleanup(() => {
		cancelPending();
		for (const copy of snapshots) copy.remove();
		snapshots.clear();
		setTranscriptExiting(false);
	});
	return { motion, skeletonOpen };
}
