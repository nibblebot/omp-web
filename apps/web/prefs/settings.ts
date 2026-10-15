import type { SettingsGroup, SettingsItem, SettingsModel, SettingsTab } from "#lib/wire/protocol";

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
