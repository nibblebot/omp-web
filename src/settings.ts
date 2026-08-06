import type { SettingsGroup, SettingsItem, SettingsModel, SettingsTab } from "./protocol";

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

/** Human-readable current value of an item, per type (TUI display parity). */
export function formatItemValue(item: SettingsItem): string {
	const value = item.value;
	switch (item.type) {
		case "boolean":
			return value ? "true" : "false";
		case "enum":
			return displayOptionValue(item, value);
		case "submenu": {
			const current = displayOptionValue(item, value);
			const option = item.options?.find(o => o.value === current);
			return option ? option.label : current;
		}
		case "text":
			if (item.secret) return value ? "••••••••" : "";
			return String(value ?? "");
		case "multiselect": {
			const selected = Array.isArray(value) ? (value as string[]) : [];
			if (selected.length === 0) return item.ordered ? "default" : "none";
			const labels = selected.map(v => item.options?.find(o => o.value === v)?.label ?? v);
			return labels.join(item.ordered ? " → " : ", ");
		}
		case "providerLimits": {
			const record = (value ?? {}) as Record<string, number>;
			const entries = Object.entries(record);
			if (entries.length === 0) return "Unlimited";
			return entries
				.map(([provider, n]) => `${provider}: ${n}`)
				.sort()
				.join(", ");
		}
	}
	return String(value ?? "");
}

/** One flat search hit; tab/group kept so results can be grouped by tab. */
export interface SettingsMatch {
	tab: SettingsTab;
	group: SettingsGroup;
	item: SettingsItem;
}

/**
 * Case-insensitive global type-to-search across EVERY tab (mirrors the TUI's
 * /settings search): matches item label, item description, group name and
 * item path. Empty/whitespace queries return nothing.
 */
export function filterSettings(model: SettingsModel, query: string): SettingsMatch[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const matches: SettingsMatch[] = [];
	for (const tab of model.tabs) {
		for (const group of tab.groups) {
			for (const item of group.items) {
				const haystack = [item.label, item.description, group.name, item.path].join("\n").toLowerCase();
				if (haystack.includes(q)) matches.push({ tab, group, item });
			}
		}
	}
	return matches;
}

/**
 * Appearance-tab groups that only matter in a real terminal (TUI rendering):
 * theme selection, status line segments, and display/terminal rendering. The
 * settings panel re-homes these groups under its "TUI" client tab.
 */
export const APPEARANCE_TUI_GROUPS: readonly string[] = ["Theme", "Status Line", "Display"];

/**
 * Terminal-only slice of the appearance tab: APPEARANCE_TUI_GROUPS groups as-is,
 * plus the terminal image renderer (terminal.showImages) from the "Images" group.
 * Any other appearance group is dropped — the appearance layout is upstream
 * TAB_GROUPS; update APPEARANCE_TUI_GROUPS if it changes. [] when the model has
 * no appearance tab.
 */
export function appearanceTuiGroups(model: SettingsModel): SettingsGroup[] {
	const appearance = model.tabs.find(tab => tab.id === "appearance");
	if (!appearance) return [];
	const groups: SettingsGroup[] = [];
	for (const group of appearance.groups) {
		if (APPEARANCE_TUI_GROUPS.includes(group.name)) {
			groups.push(group);
		} else if (group.name === "Images") {
			const items = group.items.filter(item => item.path === "terminal.showImages");
			if (items.length > 0) groups.push({ name: "Images", items });
		}
	}
	return groups;
}

/**
 * Web-relevant image-handling items from the appearance tab's "Images" group
 * (images.autoResize, images.blockImages), in schema order. [] when absent.
 */
export function appearanceWebImages(model: SettingsModel): SettingsItem[] {
	const appearance = model.tabs.find(tab => tab.id === "appearance");
	const images = appearance?.groups.find(group => group.name === "Images");
	if (!images) return [];
	return images.items.filter(item => item.path.startsWith("images."));
}
