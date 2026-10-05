import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import {
	getSettingsForTab,
	SETTING_TABS,
	type SettingDef,
	type SettingTab,
	TAB_METADATA,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import type {
	SettingsGroup,
	SettingsItem,
	SettingsModel,
	SettingsOption,
	SettingsTab,
} from "#lib/wire/protocol";

// ---------------------------------------------------------------------------
// Shared settings panel model (TUI /settings parity).
//
// The web client's settings panel is driven by the same declarative metadata
// as the TUI: registry + UI defs from @oh-my-pi/pi-coding-agent. This module
// builds the wire SettingsModel and coerces incoming values like the TUI's
// #setSettingValue. The settings host reads the layered preferences (not
// environment credentials); registered handles persist writes in the caller.
// This module never touches the filesystem itself.
// ---------------------------------------------------------------------------

/**
 * Setting definitions come from the SDK's host adapter (schema + UI metadata +
 * live visibility conditions) combined with pi-tui's overlay grammar. Both are
 * built once: the entries are static for the process, and pi-tui memoizes the
 * derived defs against this array's identity.
 */
const settingsHost = createSettingsHost();

/**
 * True when the current value differs from the schema default. Arrays compare
 * length + elementwise (===); everything else uses Object.is.
 */
export function settingChanged(current: unknown, defaultValue: unknown): boolean {
	if (Array.isArray(current) && Array.isArray(defaultValue)) {
		return (
			current.length !== defaultValue.length ||
			current.some((entry, index) => entry !== defaultValue[index])
		);
	}
	return !Object.is(current, defaultValue);
}

/**
 * Registry-driven value coercion, mirroring the TUI's #setSettingValue. Throws
 * Error on unknown/unregistered paths.
 */
export function coerceSettingValue(path: string, value: unknown): unknown {
	const setting = lookup(path);
	if (!setting) throw new Error(`Unknown setting: ${path}`);
	const schemaType = setting.type;

	// "default" resets the threshold to the schema default (-1) regardless of type.
	if (path === "compaction.thresholdPercent" && value === "default") return -1;
	if (path === "compaction.thresholdTokens" && value === "default") return -1;

	if (schemaType === "record") {
		// Values may arrive as an object (JSON-safe body) or a JSON string.
		let parsed: unknown = value;
		if (typeof value === "string") {
			try {
				parsed = JSON.parse(value);
			} catch {
				throw new Error(`Invalid record JSON for ${path}`);
			}
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new Error(`Invalid record JSON for ${path}`);
		}
		if (path === "providers.maxInFlightRequests") {
			return settingsHost.validateProviderLimits(parsed);
		}
		return parsed;
	}

	const currentValue = settingsHost.get(path);
	if (typeof currentValue === "number") {
		const n = Number(value);
		if (!Number.isFinite(n)) throw new Error(`Invalid numeric value for ${path}`);
		return n;
	}
	if (typeof currentValue === "boolean") return value === true || value === "true";
	// Optional/credential strings start undefined (never set); the TUI's
	// fallback stores the raw input in that case; mirror it here.
	if (typeof currentValue === "string" || currentValue === undefined || currentValue === null)
		return String(value);
	if (Array.isArray(currentValue)) {
		return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
	}
	throw new Error(`Unsupported setting type for ${path}`);
}

/**
 * Runtime-injected option lists (mirrors the TUI's #createSubmenu):
 * - defaultThinkingLevel: "auto" first, then the session's live thinking
 *   levels merged with the schema's declared options.
 * - theme.dark / theme.light: the themes installed on this machine.
 */
function submenuOptions(
	def: SettingDef & { type: "submenu" },
	session: SettingsSession,
	themes: string[],
): SettingsOption[] {
	if (def.path === "defaultThinkingLevel") {
		const base = def.options;
		return [
			{ value: "auto", label: "auto" },
			...session.getAvailableThinkingLevels().map((level) => {
				const existing = base.find((o) => o.value === level);
				return existing ?? { value: level, label: level };
			}),
		];
	}
	if (def.path === "theme.dark" || def.path === "theme.light") {
		return themes.map((theme) => ({ value: theme, label: theme }));
	}
	return def.options.map((o) => ({ value: o.value, label: o.label, description: o.description }));
}

/** Structural slice of the session the model builder needs. */
export type SettingsSession = {
	getAvailableThinkingLevels(): readonly string[];
	getAvailableModels(): ReadonlyArray<{ provider: string }>;
};

function defToItem(
	def: SettingDef,
	session: SettingsSession,
	themes: string[],
	providers: string[],
): SettingsItem {
	const value = settingsHost.get(def.path);
	const base = {
		path: def.path,
		label: def.label,
		description: def.description,
		value,
		changed: settingChanged(value, def.defaultValue),
	};
	switch (def.type) {
		case "boolean":
			return { ...base, type: "boolean" };
		case "enum":
			return { ...base, type: "enum", values: [...def.values] };
		case "submenu":
			return { ...base, type: "submenu", options: submenuOptions(def, session, themes) };
		case "text":
			return { ...base, type: "text", secret: def.secret };
		case "multiselect":
			return {
				...base,
				type: "multiselect",
				options: [...def.options],
				ordered: def.ordered === true,
			};
		case "providerLimits":
			return { ...base, type: "providerLimits", providers };
	}
}

function buildGroups(
	tab: SettingTab,
	session: SettingsSession,
	themes: string[],
	providers: string[],
): SettingsGroup[] {
	// getSettingsForTab orders defs by TAB_GROUPS[tab] (ungrouped first, then
	// group order), so emitting a heading on group change reproduces the TUI's
	// section layout; groups that end up with zero visible items never appear.
	const groups: SettingsGroup[] = [];
	let current: SettingsGroup | null = null;
	for (const def of getSettingsForTab(settingsHost.entries, tab)) {
		if (def.condition && !def.condition()) continue;
		const item = defToItem(def, session, themes, providers);
		if (!def.group) {
			if (!current || current.name !== "") {
				current = { name: "", items: [] };
				groups.push(current);
			}
		} else if (!current || current.name !== def.group) {
			current = { name: def.group, items: [] };
			groups.push(current);
		}
		current.items.push(item);
	}
	return groups;
}

/**
 * Build the wire settings model for one session. Everything is computed
 * fresh on every call (no caching): values, changed flags, and condition
 * gates read the live Settings singleton, so a setSetting response reflects
 * the just-applied change.
 */
export function buildSettingsModel(session: SettingsSession, themes: string[]): SettingsModel {
	// Match the TUI picker: retain configured limits even for unavailable providers.
	const limits = settingsHost.normalizeProviderLimits(
		settingsHost.get("providers.maxInFlightRequests"),
	);
	const providers = [
		...new Set([...session.getAvailableModels().map((m) => m.provider), ...Object.keys(limits)]),
	].sort((a, b) => a.localeCompare(b));
	const tabs: SettingsTab[] = SETTING_TABS.map((tab) => ({
		id: tab,
		label: TAB_METADATA[tab].label,
		groups: buildGroups(tab, session, themes, providers),
	}));
	return { tabs };
}
