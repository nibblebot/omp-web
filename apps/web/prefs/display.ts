/**
 * Browser-local display preferences: typed `omp.display.<name>` localStorage keys
 * with validation and defaults. The values live in the store as `state.display`
 * (read it in JSX: `state.display.softFade`) and are written only through
 * `setDisplayPref` (store/display.ts), which validates through this table and
 * persists. A stored value that is missing or not one of the allowed values reads
 * as the default, so a hand-edited or stale key never breaks the page.
 *
 * Not in this table: theme and font size (`omp-web:theme`, `omp-web:font-size`,
 * prefs/theme.ts), the sidebar toggles (`omp.sidebar*`, state.ts), and the SDK
 * display settings (`hideThinkingBlock`, `display.shimmer`, ...), which are
 * session settings written through `updateSetting`.
 *
 * Adding a preference (extension point for the Appearance menu):
 *  1. Add one entry to `DISPLAY_PREFS` below. `booleanPref(name, fallback)` for
 *     an on/off flag, `choicePref(name, ["a", "b"], "a")` for a fixed set of
 *     string choices (a number of rows is a choice of "10" | "20" | "all").
 *     The key is `omp.display.<name>`; the value type is inferred, so
 *     `state.display.<name>` and `setDisplayPref("<name>", value)` are typed.
 *  2. Add its row to the matching group of `components/app/AppearancePopover.tsx`
 *     (Transcript for transcript prefs): a `SettingsRowLayout` holding a
 *     `SettingToggle` (boolean), `SettingSegmented` or `SettingSelect` (choice)
 *     bound to `state.display.<name>` and `setDisplayPref`.
 *  3. Read `state.display.<name>` where the preference takes effect.
 * Nothing else changes: loading, the store field, persistence and the design
 * system's per-story reset all follow from the table.
 */

/** One stored preference: its localStorage key, default, and how a raw stored string becomes a value. */
export interface DisplayPref<T> {
	readonly key: string;
	readonly fallback: T;
	/** The value a raw stored string means, or undefined when it is not allowed. */
	readonly parse: (raw: string) => T | undefined;
	/** The raw string to store for a value. */
	readonly serialize: (value: T) => string;
}

const KEY_PREFIX = "omp.display.";

/** An on/off preference, stored as "true" or "false". */
export function booleanPref(name: string, fallback: boolean): DisplayPref<boolean> {
	return {
		key: KEY_PREFIX + name,
		fallback,
		parse: (raw) => (raw === "true" ? true : raw === "false" ? false : undefined),
		serialize: String,
	};
}

/** A preference that is one of a fixed set of strings; anything else stored reads as `fallback`. */
export function choicePref<const V extends string>(
	name: string,
	values: readonly V[],
	fallback: V,
): DisplayPref<V> {
	return {
		key: KEY_PREFIX + name,
		fallback,
		parse: (raw) => values.find((value) => value === raw),
		serialize: (value) => value,
	};
}

/** Transcript column width presets, narrowest to widest; tokens.css maps each to a cap (`--col-w-*`). */
export const TRANSCRIPT_WIDTHS = ["narrow", "default", "wide", "full"] as const;

/** Tool card modes, least to most detail: header-only cards, one row per run of calls, full cards. */
export const TOOL_CARD_MODES = ["collapsed", "consolidated", "expanded"] as const;
export type ToolCardMode = (typeof TOOL_CARD_MODES)[number];

/** Row caps for tool output in Expanded mode; "all" lifts the cap. */
export const TOOL_ROW_CHOICES = ["10", "20", "40", "all"] as const;
export type ToolRowChoice = (typeof TOOL_ROW_CHOICES)[number];

/** Every display preference. See the header comment for how to add one. */
export const DISPLAY_PREFS = {
	/** Chat column width (transcript and composer); applied as `data-width` on the root by `setDisplayPref`. */
	width: choicePref("width", TRANSCRIPT_WIDTHS, "default"),
	/** How tool calls render: header-only cards, one summary row per run of calls, or full cards. */
	toolCards: choicePref("toolCards", TOOL_CARD_MODES, "expanded"),
	/** Rows of tool output an Expanded card shows before its "hidden lines" note; "all" shows everything. */
	toolRows: choicePref("toolRows", TOOL_ROW_CHOICES, "20"),
	/** Fade in the freshly streamed tail of an assistant message. */
	softFade: booleanPref("softFade", false),
	/** How advisor note cards render in the transcript; independent of the Ctrl+O tool-output toggle. */
	advisor: choicePref("advisor", ["collapsed", "expanded"], "expanded"),
};

export type DisplayPrefName = keyof typeof DISPLAY_PREFS;

type PrefValue<P> = P extends DisplayPref<infer T> ? T : never;

/** Every preference's current value, keyed by name: the shape of `state.display`. */
export type DisplayPrefs = {
	-readonly [N in DisplayPrefName]: PrefValue<(typeof DISPLAY_PREFS)[N]>;
};

/** The slice of Storage the preferences use. */
export type DisplayStorage = Pick<Storage, "getItem" | "setItem">;

function defaultStorage(): DisplayStorage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		// Storage can be blocked outright (a sandboxed frame); preferences then live for this page only.
		return undefined;
	}
}

function readPref<T>(pref: DisplayPref<T>, storage: DisplayStorage | undefined): T {
	let raw: string | null = null;
	try {
		raw = storage?.getItem(pref.key) ?? null;
	} catch {
		raw = null;
	}
	return (raw === null ? undefined : pref.parse(raw)) ?? pref.fallback;
}

/** Defaults for every preference, without touching storage. */
export function defaultDisplayPrefs(): DisplayPrefs {
	return loadDisplayPrefs(undefined);
}

/** Every preference read from storage; each missing or invalid entry is its default. */
export function loadDisplayPrefs(
	storage: DisplayStorage | undefined = defaultStorage(),
): DisplayPrefs {
	const loaded: Record<string, unknown> = {};
	for (const [name, pref] of Object.entries(DISPLAY_PREFS) as [string, DisplayPref<unknown>][]) {
		loaded[name] = readPref(pref, storage);
	}
	return loaded as DisplayPrefs;
}

/** Persist one preference. A storage failure (quota, private mode) is ignored: the value still applies for this page. */
export function saveDisplayPref<N extends DisplayPrefName>(
	name: N,
	value: DisplayPrefs[N],
	storage: DisplayStorage | undefined = defaultStorage(),
): void {
	// The table's entries have different value types; `name` ties this one to `value`.
	const pref = DISPLAY_PREFS[name] as unknown as DisplayPref<DisplayPrefs[N]>;
	try {
		storage?.setItem(pref.key, pref.serialize(value));
	} catch {
		// See the doc comment.
	}
}
