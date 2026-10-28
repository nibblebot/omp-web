/**
 * Theme contract shared by the loader (`lib/themes/loader.ts`), the control-plane
 * route `GET /ctl/themes`, `omp-web theme check`, and the web theme picker.
 *
 * A theme file is `<stem>.json` holding a versioned document (`ThemeFile`). Built-ins
 * ship in `lib/themes/builtin/`; custom files live in `<config dir>/themes/`. A custom
 * file whose stem equals a built-in's replaces it (source "modified"). The theme id is
 * always the stem, so stored selections survive overrides.
 *
 * Token keys are CSS custom-property names without the leading `--`.
 */

/** Current theme file schema version. Older versions migrate step by step; newer ones are rejected. */
export const THEME_SCHEMA_VERSION = 1;

/** Allowed file stems (and therefore theme ids). Anything else is a load failure. */
export const THEME_STEM_PATTERN = /^[a-z0-9-]+$/;

/** Theme id selected for both schemes when nothing (valid) is stored. */
export const DEFAULT_THEME_ID = "catppuccin";

export type ThemeScheme = "dark" | "light";
export const THEME_SCHEMES: readonly ThemeScheme[] = ["dark", "light"];

/** Tokens every variant must set. */
export const THEME_CORE_TOKENS = [
	"bg",
	"panel",
	"text",
	"muted",
	"border",
	"accent",
	"success",
	"warning",
	"error",
] as const;
export type ThemeCoreToken = (typeof THEME_CORE_TOKENS)[number];

/** Tokens a variant may set; any it omits are derived from the core. */
export const THEME_OPTIONAL_TOKENS = [
	// surfaces
	"bg-deep",
	"panel-2",
	"btn",
	"hover",
	"border-strong",
	"backdrop",
	"shadow-color",
	// text
	"muted-2",
	"muted-3",
	"shimmer-band",
	"error-text",
	// accent
	"accent-dim",
	"accent-border",
	"purple",
	// status surfaces
	"success-bg",
	"success-border",
	"warning-bg",
	"warning-border",
	"error-bg",
	"error-border",
	"stop-bg",
	// diff
	"diff-add-bg",
	"diff-add-text",
	"diff-del-bg",
	"diff-del-text",
	// tool categories (hues avoid red and green)
	"tool-shell",
	"tool-read",
	"tool-write",
	"tool-search",
	"tool-agents",
	"tool-other",
	// syntax
	"syn-keyword",
	"syn-string",
	"syn-number",
	"syn-comment",
	"syn-title",
	"syn-attr",
	"syn-meta",
	// settings surfaces
	"settings-accent",
	"settings-title",
	"settings-desc",
	"settings-warning",
	"settings-line",
	"settings-divider",
	"settings-fill",
	"settings-track-off",
	"settings-mark-bg",
	"settings-mark-fg",
	// brand mark (OmpWebLogoIcon tile and base band)
	"logo-tile",
	"logo-base",
] as const;
export type ThemeOptionalToken = (typeof THEME_OPTIONAL_TOKENS)[number];

export type ThemeToken = ThemeCoreToken | ThemeOptionalToken;
export const THEME_TOKENS: readonly ThemeToken[] = [...THEME_CORE_TOKENS, ...THEME_OPTIONAL_TOKENS];

/**
 * A color value as written in a file: `#rgb`, `#rrggbb`, `#rrggbbaa`, or
 * `oklch(L% C h)` / `oklch(L% C h / a)`. Nothing else is accepted.
 */
export type ThemeColor = string;

/** One variant as written in a file (schema version 1). */
export type ThemeVariantInput = Record<ThemeCoreToken, ThemeColor> &
	Partial<Record<ThemeOptionalToken, ThemeColor>>;

/** A theme file, schema version 1. At least one of `variants.dark` / `variants.light`. */
export interface ThemeFile {
	$schema?: string;
	schemaVersion: typeof THEME_SCHEMA_VERSION;
	name: string;
	variants: Partial<Record<ThemeScheme, ThemeVariantInput>>;
}

/**
 * A contrast or hue finding on a resolved variant (`contrastWarnings` in contrast.ts).
 * Informational; never blocks loading, and reported only by `omp-web theme check`.
 */
export type ThemeContrastWarning =
	| {
			kind: "contrast";
			fg: ThemeToken;
			/** Background token; diff backgrounds are composited over `panel` before measuring. */
			bg: ThemeToken;
			ratio: number;
			min: number;
	  }
	| {
			kind: "hue";
			token: ThemeToken;
			/** Why the hue is flagged, e.g. "reads as red (status color)". */
			reason: string;
	  };

/** A variant with every token resolved to a concrete color string (hex or oklch, emitted as-is). */
export interface ThemeVariant {
	scheme: ThemeScheme;
	tokens: Record<ThemeToken, string>;
}

export type ThemeSource = "builtin" | "custom" | "modified";

export interface ThemeEntry {
	/** The file stem. */
	id: string;
	/** Display name from the file's `name`. */
	name: string;
	source: ThemeSource;
	variants: Partial<Record<ThemeScheme, ThemeVariant>>;
}

export interface ThemeLoadFailure {
	/** File name inside the themes dir, e.g. `my theme.json`. */
	file: string;
	errors: string[];
}

/** Body of `GET /ctl/themes`. */
export interface ThemesPayload {
	/** Absolute path of `<config dir>/themes/` (may not exist yet). */
	dir: string;
	/** Built-ins first in their fixed order (catppuccin, gruvbox, everforest), then custom by name. */
	themes: ThemeEntry[];
	failures: ThemeLoadFailure[];
}

/** Result of validating, migrating and resolving one file. */
export type ThemeParseResult = { ok: true; entry: ThemeEntry } | { ok: false; errors: string[] };
