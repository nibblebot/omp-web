import type { SettingsModel } from "#lib/wire/protocol";
import { isAppearanceSetting } from "./settings";

/**
 * Settings sheet tab metadata (display contract for the sidebar, the stream
 * headings and the narrow picker). Pure data plus helpers over the wire model,
 * so it stays unit-testable without the store.
 *
 * Three kinds of tab share one sidebar and one scroll stream:
 * - "session": rows that act on the attached session only; absent without one.
 * - "sdk": a tab of the settings model; `id` matches `SettingsTab.id`.
 * - "client": browser-local preferences (Browser, Features).
 *
 * Each tab belongs to a `section`: `session` (the attached session), `omp`
 * (the SDK's own settings) or `omp-web` (this web UI). The sidebar labels the
 * latter two; the session tab sits above them with no label.
 */

/** Glyph names; the sidebar maps each one to an icon component. */
export type SettingsTabIconName =
	| "pencil"
	| "crosshair"
	| "keyboard"
	| "layers"
	| "memory"
	| "files"
	| "terminal"
	| "wand"
	| "list"
	| "server"
	| "monitor"
	| "flask"
	| "bot";

export type SettingsTabKind = "session" | "sdk" | "client";

/** Which of the three stream parts a tab belongs to. */
export type SettingsTabSection = "session" | "omp" | "omp-web";

export interface SettingsTabMeta {
	id: string;
	label: string;
	icon: SettingsTabIconName;
	kind: SettingsTabKind;
	section: SettingsTabSection;
}

/** Tabs in stream order: This session, the 10 SDK tabs (omp), then the client tabs (omp-web). */
export const SETTINGS_TABS: SettingsTabMeta[] = [
	{
		id: "session",
		label: "This Session",
		icon: "bot",
		kind: "session",
		section: "session",
	},
	{
		id: "appearance",
		label: "Display",
		icon: "pencil",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "model",
		label: "Model",
		icon: "crosshair",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "interaction",
		label: "Interaction",
		icon: "keyboard",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "context",
		label: "Context",
		icon: "layers",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "memory",
		label: "Memory",
		icon: "memory",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "files",
		label: "Files",
		icon: "files",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "shell",
		label: "Shell",
		icon: "terminal",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "tools",
		label: "Tools",
		icon: "wand",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "tasks",
		label: "Tasks",
		icon: "list",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "providers",
		label: "Providers",
		icon: "server",
		kind: "sdk",
		section: "omp",
	},
	{
		id: "web-ui",
		label: "Browser",
		icon: "monitor",
		kind: "client",
		section: "omp-web",
	},
	{
		id: "features",
		label: "Features",
		icon: "flask",
		kind: "client",
		section: "omp-web",
	},
];

/** Metadata for one tab id; undefined for an unknown id. */
export function settingsTabMeta(id: string): SettingsTabMeta | undefined {
	return SETTINGS_TABS.find((tab) => tab.id === id);
}

/**
 * Tabs the stream and sidebar list. The session tab needs an attached
 * session. SDK tabs follow the loaded model (a tab the model does not carry
 * has nothing to show); with no model yet they all stay listed so the sidebar
 * does not collapse while settings load.
 */
export function visibleSettingsTabs(
	model: SettingsModel | null,
	sessionAttached: boolean,
): SettingsTabMeta[] {
	const present = model ? new Set(model.tabs.map((tab) => tab.id)) : null;
	return SETTINGS_TABS.filter((tab) => {
		if (tab.kind === "session") return sessionAttached;
		if (tab.kind === "sdk") return present === null || present.has(tab.id);
		return true;
	});
}

/** The tab a fresh sheet opens on: the first visible one. */
export function defaultSettingsTabId(tabs: readonly SettingsTabMeta[]): string {
	return tabs[0]?.id ?? "";
}

/** Consecutive tabs of one section, in stream order; the sidebar labels each run. */
export interface SettingsTabRun {
	section: SettingsTabSection;
	tabs: SettingsTabMeta[];
}

/** Splits tabs into runs of equal section, keeping order. */
export function settingsTabRuns(tabs: readonly SettingsTabMeta[]): SettingsTabRun[] {
	const runs: SettingsTabRun[] = [];
	for (const tab of tabs) {
		const last = runs[runs.length - 1];
		if (last && last.section === tab.section) last.tabs.push(tab);
		else runs.push({ section: tab.section, tabs: [tab] });
	}
	return runs;
}

/** DOM id of a tab's heading in the stream; the sidebar and deep links scroll to it. */
export function settingsTabHeadingId(tabId: string): string {
	return `settings-heading-${tabId}`;
}

/** DOM id of a section inside a tab body; the sidebar scrolls to it. */
export function settingsSectionId(tabId: string, sectionName: string): string {
	return `settings-${tabId}-${sectionName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * Scroll-spy: the index of the last heading whose top has crossed `line`, or
 * -1 when none has. `offsets` are heading tops relative to the body's top
 * edge, in document order; `line` is the spy line's distance below that edge.
 * At the very top the first heading wins, so a short first tab is not skipped
 * because the next heading already sits above the line; at the very bottom
 * the last heading wins, so a short final tab that can never scroll to the
 * line still gets highlighted.
 */
export function scrollSpyIndex(
	offsets: readonly number[],
	line: number,
	edge: "top" | "bottom" | null,
): number {
	if (offsets.length === 0) return -1;
	if (edge === "top") return 0;
	if (edge === "bottom") return offsets.length - 1;
	let index = -1;
	for (let i = 0; i < offsets.length; i++) {
		if (offsets[i] <= line) index = i;
	}
	return index;
}

/**
 * Changed-setting count per model tab id (`item.changed`, every group,
 * including Advanced; rows owned by the Appearance sheet are not counted). Tabs absent from the model are absent from the map;
 * read it with tabBadgeCount, which defaults to 0.
 */
export function changedCountsByTab(model: SettingsModel | null): Map<string, number> {
	const counts = new Map<string, number>();
	if (!model) return counts;
	for (const tab of model.tabs) {
		let changed = 0;
		for (const group of tab.groups) {
			for (const item of group.items)
				if (item.changed && !isAppearanceSetting(item.path)) changed++;
		}
		counts.set(tab.id, changed);
	}
	return counts;
}

/** Sidebar badge for a tab: its changed count; 0 (no badge) for client tabs. */
export function tabBadgeCount(counts: Map<string, number>, tab: SettingsTabMeta): number {
	return tab.kind === "sdk" ? (counts.get(tab.id) ?? 0) : 0;
}
