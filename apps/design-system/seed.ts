import { batch } from "solid-js";
import { unwrap } from "solid-js/store";
import { GROUPS_KEY } from "../web/components/fleet/sidebar/ProjectGroups";
import { ENABLEABLE_FEATURE_IDS, FEATURES } from "../web/features/manifest";
import { markFeaturesActive, setFeaturePreference } from "../web/features/preferences";
import { cancelDangerConfirm } from "../web/prompt/danger-confirm";
import { SIDEBAR_RUNNING_ONLY_KEY, setState, state } from "../web/state";
import { closeDownload } from "../web/store/downloads";
import { jobPollAttached } from "../web/store/job-poll";
import { clearJobCancelError } from "../web/store/jobs";
import { resetSession } from "./session";
import type { StoreSeed } from "./registry";

/**
 * Store seeding. apps/web/state.ts owns ONE global store; components read it
 * directly. Stories never poke it ad hoc: they declare a `seed` and the
 * showcase calls `applySeeds` before rendering.
 *
 * The pristine snapshot is taken at module load, before any story runs. It is
 * a structured clone (the store holds Maps, which structuredClone keeps), so
 * later in-place mutation of store objects cannot corrupt it.
 */
const pristine = structuredClone(unwrap(state));

/**
 * Restore every top-level store field to its import-time value, close the
 * self-mounting dialogs whose state lives in module signals outside the store
 * (danger confirm, download, the shared job poll's answer), restore manifest-default feature preferences
 * (persisted in localStorage, read by core UI such as the Analysis view) and the
 * page set that boot installs (every feature the app can enable; an
 * in-development feature is never active), and expand every project group
 * (collapse state is persisted in localStorage too), so one story's state
 * never shows in the next.
 */
export function resetStore(): void {
	batch(() => {
		setState(structuredClone(pristine));
		cancelDangerConfirm();
		closeDownload();
		// The job poll and a Cancel refusal live in module signals too: forget them as a fresh attach does.
		jobPollAttached();
		clearJobCancelError();
		for (const feature of FEATURES) setFeaturePreference(feature.id, feature.defaultEnabled);
		// The page boots with every enableable feature active; a story that narrows the set must not leak it.
		markFeaturesActive(ENABLEABLE_FEATURE_IDS);
		// Project groups collapse through localStorage: every story starts expanded.
		localStorage.removeItem(GROUPS_KEY);
		// The running-only filter persists through localStorage as well: every story starts unfiltered.
		localStorage.removeItem(SIDEBAR_RUNNING_ONLY_KEY);
	});
}

function applySeed(seed: StoreSeed | undefined): void {
	if (seed === undefined) return;
	if (typeof seed === "function") seed();
	else setState(structuredClone(seed));
}

/**
 * Reset the store and the fake session (session.ts), then apply each seed in
 * order (story first, variant second).
 */
export function applySeeds(...seeds: Array<StoreSeed | undefined>): void {
	batch(() => {
		resetStore();
		resetSession();
		for (const seed of seeds) applySeed(seed);
	});
}
