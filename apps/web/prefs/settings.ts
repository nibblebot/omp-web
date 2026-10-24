import type {
	SettingsGroup,
	SettingsItem,
	SettingsModel,
	SettingsTab,
	SettingView,
} from "#lib/wire/protocol";

/**
 * Pure display helpers for the settings panel (TUI /settings parity). No
 * state imports; everything is derived from the wire model so these stay
 * unit-testable in isolation.
 */

/**
 * TUI parity: compaction thresholds store -1 for "default". Any control
 * (and formatItemValue) must display/select the option value "default"
 * whenever the stored value is -1; the panel sends "default" back and the
 * server maps it to -1.
 */
const COMPACTION_DEFAULT_PATHS: Record<string, true> = {
	"compaction.thresholdPercent": true,
	"compaction.thresholdTokens": true,
};

/** The value a control should show/select, mapping stored -1 → "default". */
export function displayOptionValue(item: SettingsItem, value: unknown): string {
	if (COMPACTION_DEFAULT_PATHS[item.path] && value === -1) return "default";
	return String(value ?? "");
}

/** One flat search hit; tab/group kept so results can be grouped by tab. */
export interface SettingsMatch {
	tab: SettingsTab;
	group: SettingsGroup;
	item: SettingsItem;
}

/**
 * Case-insensitive global type-to-search over every tab's items. Matches item
 * label, item description, group name and item path; callers group the hits by
 * tab and section. Empty/whitespace queries return nothing.
 */
export function filterSettings(model: SettingsModel, query: string): SettingsMatch[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const matches: SettingsMatch[] = [];
	for (const tab of model.tabs) {
		for (const group of tab.groups) {
			for (const item of group.items) {
				const haystack = [item.label, item.description, group.name, item.path]
					.join("\n")
					.toLowerCase();
				if (haystack.includes(q)) matches.push({ tab, group, item });
			}
		}
	}
	return matches;
}

/** Settings that do nothing until another setting is on: path -> controlling path and the reason shown while it is off. */
const DEPENDENCIES: Record<string, { on: string; reason: string }> = {
	"display.showTurnTime": {
		on: "display.showTokenUsage",
		reason: "Turn on Show Token Usage to use turn time.",
	},
};

/** Why a row cannot take effect right now, or null when it can. */
export function unmetDependency(path: string, valueOf: (path: string) => unknown): string | null {
	const dep = DEPENDENCIES[path];
	if (!dep) return null;
	return valueOf(dep.on) === true ? null : dep.reason;
}

/** Muted suffix for settings whose change applies only at session start; null otherwise (live, and the legacy `restart`). */
export function effectNote(effect: SettingView["effect"] | undefined): string | null {
	return effect === "next-session" ? "New sessions only." : null;
}

/**
 * Browser-local and session-scoped rows outside the SDK model, so settings search reaches them here.
 * Each names the tab that renders it and its label matches the row's label. `session` rows render only
 * with a session attached; `signedIn` rows only after sign-in.
 */
const WEB_UI_SEARCH_ROWS: {
	label: string;
	keywords: string;
	tabId: string;
	session?: boolean;
	signedIn?: boolean;
}[] = [
	{ label: "Theme", keywords: "theme dark light color appearance", tabId: "web-ui" },
	{ label: "Font Size", keywords: "text size zoom larger smaller", tabId: "web-ui" },
	{
		label: "Browser Notification Permission",
		keywords: "notify notifications desktop alert os permission",
		tabId: "web-ui",
	},
	{ label: "Soft Fade", keywords: "fade transcript smooth streaming", tabId: "web-ui" },
	{ label: "Usage in Sidebar", keywords: "usage sidebar tokens cost", tabId: "web-ui" },
	{
		label: "Two-Line Session Titles",
		keywords: "session title sidebar roster row lines wrap",
		tabId: "web-ui",
	},
	{
		label: "Title-First Workspace Rows",
		keywords: "session title branch sidebar roster row layout workspace",
		tabId: "web-ui",
	},
	{
		label: "Sign Out",
		keywords: "sign out logout log out account",
		tabId: "web-ui",
		signedIn: true,
	},
	{
		label: "Fast Mode",
		keywords: "fast priority service tier speed",
		tabId: "session",
		session: true,
	},
	{
		label: "Auto-Retry",
		keywords: "retry retries error recover",
		tabId: "session",
		session: true,
	},
	{
		label: "Auto-Compact",
		keywords: "compact compaction context summarize",
		tabId: "session",
		session: true,
	},
	{
		label: "Login Providers",
		keywords: "login provider auth sign in oauth api key",
		tabId: "providers",
		session: true,
	},
];

/** What the stream renders right now, so search never offers a row it cannot show. */
export interface WebUiContext {
	sessionAttached: boolean;
	signedIn: boolean;
}

/** A matching non-model row: its label and the tab that renders it. */
export interface WebUiSearchRow {
	label: string;
	tabId: string;
}

/** Non-model rows matching the query and rendered in this context. */
export function filterWebUiSettings(query: string, context: WebUiContext): WebUiSearchRow[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	return WEB_UI_SEARCH_ROWS.filter(
		(row) =>
			(row.session !== true || context.sessionAttached) &&
			(row.signedIn !== true || context.signedIn) &&
			`${row.label} ${row.keywords}`.toLowerCase().includes(q),
	).map(({ label, tabId }) => ({ label, tabId }));
}
