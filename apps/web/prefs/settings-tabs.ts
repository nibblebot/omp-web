import type { SettingsModel } from "#lib/wire/protocol";

/**
 * Settings sheet tab metadata (display contract for the sidebar, the body
 * hero and the narrow picker). Pure data plus helpers over the wire model, so
 * it stays unit-testable without the store.
 *
 * Three kinds of tab share one sidebar:
 * - "sdk": a tab of the settings model; `id` matches `SettingsTab.id`.
 * - "installed": plugins, backed by the plugin store rather than the model.
 * - "client": browser-local preferences (Web UI, Features).
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
	| "package"
	| "monitor"
	| "flask";

export type SettingsTabKind = "sdk" | "installed" | "client";

export interface SettingsTabMeta {
	id: string;
	label: string;
	icon: SettingsTabIconName;
	kind: SettingsTabKind;
	/** One-sentence description shown under the tab heading. */
	lead: string;
}

/** Tabs in sidebar order: the 10 SDK tabs, Installed, then the client tabs. */
export const SETTINGS_TABS: SettingsTabMeta[] = [
	{
		id: "appearance",
		label: "Appearance",
		icon: "pencil",
		kind: "sdk",
		lead: "Theme, composer, status line and how the transcript renders.",
	},
	{
		id: "model",
		label: "Model",
		icon: "crosshair",
		kind: "sdk",
		lead: "Thinking, sampling, the system prompt, retries and the helper models.",
	},
	{
		id: "interaction",
		label: "Interaction",
		icon: "keyboard",
		kind: "sdk",
		lead: "Input, approvals, notifications, speech and what happens at startup.",
	},
	{
		id: "context",
		label: "Context",
		icon: "layers",
		kind: "sdk",
		lead: "What the model sees, and when and how the conversation compacts.",
	},
	{
		id: "memory",
		label: "Memory",
		icon: "memory",
		kind: "sdk",
		lead: "What omp remembers across sessions and where it keeps it.",
	},
	{
		id: "files",
		label: "Files",
		icon: "files",
		kind: "sdk",
		lead: "How files are read, summarized and edited, and the language servers.",
	},
	{
		id: "shell",
		label: "Shell",
		icon: "terminal",
		kind: "sdk",
		lead: "The bash tool and the eval runtimes.",
	},
	{
		id: "tools",
		label: "Tools",
		icon: "wand",
		kind: "sdk",
		lead: "Which tools the model has, their limits and the external integrations.",
	},
	{
		id: "tasks",
		label: "Tasks",
		icon: "list",
		kind: "sdk",
		lead: "Modes, subagents, isolation and custom commands.",
	},
	{
		id: "providers",
		label: "Providers",
		icon: "server",
		kind: "sdk",
		lead: "Services, provider protocols, timeouts and privacy.",
	},
	{
		id: "installed",
		label: "Installed",
		icon: "package",
		kind: "installed",
		lead: "Plugins installed for you and this project. Configure one to turn it or its features on and off.",
	},
	{
		id: "web-ui",
		label: "Web UI",
		icon: "monitor",
		kind: "client",
		lead: "Preferences kept in this browser: theme, text size and notifications.",
	},
	{
		id: "features",
		label: "Features",
		icon: "flask",
		kind: "client",
		lead: "Optional parts of the web UI that load on demand in this browser.",
	},
];

/** The tab a fresh sheet opens on. */
export const DEFAULT_SETTINGS_TAB_ID = "appearance";

/** Metadata for one tab id; undefined for an unknown id. */
export function settingsTabMeta(id: string): SettingsTabMeta | undefined {
	return SETTINGS_TABS.find((tab) => tab.id === id);
}

/**
 * Tabs the sidebar lists. SDK tabs follow the loaded model (a tab the model
 * does not carry has nothing to show); with no model yet they all stay
 * listed so the sidebar does not collapse while settings load.
 */
export function visibleSettingsTabs(model: SettingsModel | null): SettingsTabMeta[] {
	if (!model) return [...SETTINGS_TABS];
	const present = new Set(model.tabs.map((tab) => tab.id));
	return SETTINGS_TABS.filter((tab) => tab.kind !== "sdk" || present.has(tab.id));
}

/** DOM id of a section inside a tab body; the sidebar scrolls to it. */
export function settingsSectionId(tabId: string, sectionName: string): string {
	return `settings-${tabId}-${sectionName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/**
 * Changed-setting count per model tab id (`item.changed`, every group,
 * including Advanced). Tabs absent from the model are absent from the map;
 * read it with tabBadgeCount, which defaults to 0.
 */
export function changedCountsByTab(model: SettingsModel | null): Map<string, number> {
	const counts = new Map<string, number>();
	if (!model) return counts;
	for (const tab of model.tabs) {
		let changed = 0;
		for (const group of tab.groups) {
			for (const item of group.items) if (item.changed) changed++;
		}
		counts.set(tab.id, changed);
	}
	return counts;
}

/** Sidebar badge for a tab: its changed count; 0 (no badge) for Installed and client tabs. */
export function tabBadgeCount(counts: Map<string, number>, tab: SettingsTabMeta): number {
	return tab.kind === "sdk" ? (counts.get(tab.id) ?? 0) : 0;
}
