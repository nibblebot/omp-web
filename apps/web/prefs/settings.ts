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

/** Badge text for when a change takes effect; null for live settings (no badge needed). */
export function effectLabel(effect: SettingView["effect"] | undefined): string | null {
	if (effect === "next-session") return "Next session";
	if (effect === "restart") return "Restart";
	return null;
}

/**
 * Browser-local rows in WebUiSettings. They are not in the SDK model, so settings search reaches them here.
 * `session` rows render only with a session attached; `signedIn` rows only after sign-in.
 */
const WEB_UI_SEARCH_ROWS: {
	label: string;
	keywords: string;
	session?: boolean;
	signedIn?: boolean;
}[] = [
	{ label: "theme preference", keywords: "theme dark light color appearance" },
	{ label: "font size", keywords: "text size zoom larger smaller" },
	{
		label: "browser notification permission",
		keywords: "notify notifications desktop alert os permission",
	},
	{ label: "soft fade", keywords: "fade transcript smooth streaming" },
	{ label: "usage in sidebar", keywords: "usage sidebar tokens cost" },
	{ label: "fast mode", keywords: "fast priority service tier speed", session: true },
	{ label: "auto-retry", keywords: "retry retries error recover", session: true },
	{ label: "Login providers…", keywords: "login provider auth sign in oauth api key" },
	{ label: "sign out", keywords: "sign out logout log out account", signedIn: true },
];

/** What the Web UI tab renders right now, so search never offers a row it cannot show. */
export interface WebUiContext {
	sessionAttached: boolean;
	signedIn: boolean;
}

/** Web UI row labels matching the query and rendered in this context; each one lives on the Web UI tab. */
export function filterWebUiSettings(query: string, context: WebUiContext): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	return WEB_UI_SEARCH_ROWS.filter(
		(row) =>
			(row.session !== true || context.sessionAttached) &&
			(row.signedIn !== true || context.signedIn) &&
			`${row.label} ${row.keywords}`.toLowerCase().includes(q),
	).map((row) => row.label);
}

/** Daily rows for the Common tab, by group. Paths the model lacks are skipped. */
const COMMON_GROUPS: { title: string; paths: string[] }[] = [
	{
		title: "Chat",
		paths: [
			"defaultThinkingLevel",
			"hideThinkingBlock",
			"expandThinkingBlocks",
			"display.hideToolActivity",
			"display.showTokenUsage",
			"display.showTurnTime",
			"display.pinnedAgents",
			"compaction.enabled",
		],
	},
	{
		title: "Steering and approvals",
		paths: ["steeringMode", "followUpMode", "tools.approvalMode"],
	},
	{ title: "Notifications", paths: ["completion.notify", "error.notify", "ask.notify"] },
];

/** Common tab groups with their model items, in COMMON_GROUPS order. Empty groups are dropped. */
export function commonSettingGroups(
	model: SettingsModel | null,
): { title: string; items: SettingsItem[] }[] {
	if (!model) return [];
	const byPath = new Map<string, SettingsItem>();
	for (const tab of model.tabs) {
		for (const group of tab.groups) {
			for (const item of group.items) byPath.set(item.path, item);
		}
	}
	return COMMON_GROUPS.map(({ title, paths }) => ({
		title,
		items: paths.flatMap((path) => byPath.get(path) ?? []),
	})).filter((group) => group.items.length > 0);
}
