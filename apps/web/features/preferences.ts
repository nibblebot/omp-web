import { createSignal } from "solid-js";
import { FEATURE_BY_ID, FEATURES, isFeatureId, type FeatureId } from "./manifest";

/** localStorage key: JSON object of explicit per-feature choices ({ [id]: boolean }). */
export const FEATURES_KEY = "omp.features";

export type FeaturePreferences = Record<FeatureId, boolean>;

/**
 * Resolve stored choices against the manifest defaults. Unknown ids and
 * non-boolean values are ignored; unparseable storage falls back to defaults.
 * An "in-development" feature resolves to off whatever is stored or its default.
 * Nothing rewrites stored keys in place: `setFeaturePreference` saves manifest
 * ids only, so an unknown key drops on the next change.
 */
export function resolveFeaturePreferences(raw: string | null): FeaturePreferences {
	const prefs = Object.fromEntries(
		FEATURES.map((f) => [f.id, f.defaultEnabled && f.status !== "in-development"]),
	) as FeaturePreferences;
	if (raw === null) return prefs;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return prefs;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return prefs;
	for (const [id, value] of Object.entries(parsed)) {
		if (
			isFeatureId(id) &&
			typeof value === "boolean" &&
			FEATURE_BY_ID[id].status !== "in-development"
		)
			prefs[id] = value;
	}
	return prefs;
}

const [preferences, setPreferences] = createSignal<FeaturePreferences>(
	resolveFeaturePreferences(
		typeof localStorage !== "undefined" ? localStorage.getItem(FEATURES_KEY) : null,
	),
);

/** Stored choices (defaults applied). Reactive; `setFeatureEnabled` in registry.ts applies a change. */
export const featurePreferences = preferences;

/**
 * Persist one choice. Only ids that differ from the manifest default are stored.
 * Turning an "in-development" feature on is refused: no in-memory change, no storage write.
 */
export function setFeaturePreference(id: FeatureId, enabled: boolean): void {
	if (enabled && FEATURE_BY_ID[id].status === "in-development") return;
	const next = { ...preferences(), [id]: enabled };
	setPreferences(next);
	if (typeof localStorage === "undefined") return;
	const overrides = Object.fromEntries(
		FEATURES.filter((f) => next[f.id] !== f.defaultEnabled).map((f) => [f.id, next[f.id]]),
	);
	if (Object.keys(overrides).length === 0) localStorage.removeItem(FEATURES_KEY);
	else localStorage.setItem(FEATURES_KEY, JSON.stringify(overrides));
}

/** Ids the stored choices enable, in manifest order. */
export function preferredFeatureIds(): FeatureId[] {
	const prefs = preferences();
	return FEATURES.filter((f) => prefs[f.id]).map((f) => f.id);
}

const [active, setActive] = createSignal<ReadonlySet<FeatureId>>(new Set());

/**
 * Features whose modules are loaded and wired on this page. The registry is
 * the only writer: `activateFeatures` and `setFeatureEnabled` (registry.ts).
 */
export const activeFeatureIds = active;

/** Registry-only: record the activated set. */
export function markFeaturesActive(ids: Iterable<FeatureId>): void {
	setActive(new Set(ids));
}
