import { batch } from "solid-js";
import { unwrap } from "solid-js/store";
import { cancelDangerConfirm } from "../web/prompt/danger-confirm";
import { setState, state } from "../web/state";
import { closeDownload } from "../web/store/downloads";
import { resetDaemon } from "./daemon";
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
 * Restore every top-level store field to its import-time value, and close the
 * self-mounting dialogs whose state lives in module signals outside the store
 * (danger confirm, download), so one story's open dialog never shows in the next.
 */
export function resetStore(): void {
	batch(() => {
		setState(structuredClone(pristine));
		cancelDangerConfirm();
		closeDownload();
	});
}

function applySeed(seed: StoreSeed | undefined): void {
	if (seed === undefined) return;
	if (typeof seed === "function") seed();
	else setState(structuredClone(seed));
}

/**
 * Reset the store and the fake daemon (daemon.ts), then apply each seed in
 * order (story first, variant second).
 */
export function applySeeds(...seeds: Array<StoreSeed | undefined>): void {
	batch(() => {
		resetStore();
		resetDaemon();
		for (const seed of seeds) applySeed(seed);
	});
}
