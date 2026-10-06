import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { Settings, type RawSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
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
	SettingView,
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
export function coerceSettingValue(
	path: string,
	value: unknown,
	scope = Settings.instance,
): unknown {
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

	const currentValue = setting.layered(scope);
	if (typeof currentValue === "number") {
		if (value === null || value === "" || typeof value === "boolean")
			throw new Error(`Invalid numeric value for ${path}`);
		const n = Number(value);
		if (!Number.isFinite(n)) throw new Error(`Invalid numeric value for ${path}`);
		return n;
	}
	if (typeof currentValue === "boolean") {
		if (value === true || value === "true") return true;
		if (value === false || value === "false") return false;
		throw new Error(`Invalid boolean value for ${path}`);
	}
	if (typeof currentValue === "string" || currentValue === undefined || currentValue === null) {
		// Optional/credential strings start undefined (never set); the TUI's
		// fallback stores the raw input in that case; mirror it here.
		if (typeof value !== "string") return String(value);
		return value;
	}
	if (Array.isArray(currentValue)) {
		if (typeof value === "string") {
			try {
				const parsed: unknown = JSON.parse(value);
				if (Array.isArray(parsed)) return parsed.filter((entry) => typeof entry === "string");
			} catch {
				/* fall through to empty */
			}
			return [];
		}
		return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
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

export interface SettingsModelOptions {
	settings?: Settings;
	target?: "current-session" | "future-sessions";
	projectWritable?: boolean;
	projectWritablePaths?: ReadonlySet<string>;
}

function layerValue(layer: unknown, path: string): unknown {
	let value = layer;
	for (const segment of path.split(".")) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) return undefined;
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
}

/** Timing is conservative for defaults consumed only when a session is constructed. */
export function settingEffect(path: string): SettingView["effect"] {
	if (
		path === "defaultThinkingLevel" ||
		path === "memory.backend" ||
		path.startsWith("sampling.") ||
		path.startsWith("advisor.") ||
		path.startsWith("compaction.") ||
		path.startsWith("providers.") ||
		path.startsWith("images.")
	)
		return "live";
	if (path.startsWith("tui.") || path.startsWith("theme.")) return "restart";
	return "next-session";
}

export function settingView(
	path: string,
	scope: Settings,
	options: SettingsModelOptions = {},
	global = scope.getGlobalSettings(),
	project = scope.getProjectSettings(),
): SettingView {
	const setting = lookup(path);
	if (!setting) throw new Error(`Unknown setting: ${path}`);
	// Deliberately do not call setting.get()/envValue(): credential values stay outside DTOs.
	const effective = setting.layered(scope);
	const provenance = scope.getProvenance(setting);
	const source = provenance === "overlay" ? "cli" : provenance;
	const owned = layerValue(global, path);
	const projectValue = layerValue(project, path);
	const explicit =
		projectValue !== undefined &&
		(options.projectWritablePaths?.has(path) ?? options.projectWritable)
			? { value: projectValue, layer: "project" }
			: owned !== undefined
				? { value: owned, layer: "global" }
				: undefined;
	const warnings: string[] = [];
	if (scope.warnState.invalid.has(path))
		warnings.push("SDK ignored an invalid configured value and is using the default.");
	if (scope.warnState.items.get(path)?.size)
		warnings.push("SDK reported unknown configured list entries.");
	if (
		source === "runtime" ||
		source === "cli" ||
		(source === "project" && explicit?.layer !== "project")
	)
		warnings.push(`The ${source} layer overrides global edits.`);
	return {
		path,
		effective,
		source,
		explicit,
		canUnset: explicit !== undefined,
		warnings,
		effect: options.target === "future-sessions" ? "next-session" : settingEffect(path),
	};
}

function defToItem(
	def: SettingDef,
	session: SettingsSession,
	themes: string[],
	providers: string[],
	options: SettingsModelOptions,
	global: RawSettings,
	project: RawSettings,
): SettingsItem {
	const view = settingView(
		def.path,
		options.settings ?? Settings.instance,
		options,
		global,
		project,
	);
	const value = view.effective;
	const base = {
		path: def.path,
		label: def.label,
		description: def.description,
		value,
		changed: settingChanged(value, def.defaultValue),
		view,
	};
	const schema = lookup(def.path);
	if (schema?.type === "record" && def.type !== "providerLimits")
		return { ...base, type: "record" };
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
	options: SettingsModelOptions,
	global: RawSettings,
	project: RawSettings,
): SettingsGroup[] {
	// getSettingsForTab orders defs by TAB_GROUPS[tab] (ungrouped first, then
	// group order), so emitting a heading on group change reproduces the TUI's
	// section layout; groups that end up with zero visible items never appear.
	const groups: SettingsGroup[] = [];
	let current: SettingsGroup | null = null;
	for (const def of getSettingsForTab(createSettingsHost().entries, tab)) {
		if (def.condition && !def.condition()) continue;
		const item = defToItem(def, session, themes, providers, options, global, project);
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
export function buildSettingsModel(
	session: SettingsSession,
	themes: string[],
	options: SettingsModelOptions = {},
): SettingsModel {
	const scope = options.settings ?? Settings.instance;
	const global = scope.getGlobalSettings();
	const project = scope.getProjectSettings();
	// Match the TUI picker: retain configured limits even for unavailable providers.
	const limits = settingsHost.normalizeProviderLimits(
		lookup("providers.maxInFlightRequests")!.layered(scope),
	);
	const providers = [
		...new Set([...session.getAvailableModels().map((m) => m.provider), ...Object.keys(limits)]),
	].sort((a, b) => a.localeCompare(b));
	const tabs: SettingsTab[] = SETTING_TABS.map((tab) => ({
		id: tab,
		label: TAB_METADATA[tab].label,
		groups: buildGroups(tab, session, themes, providers, options, global, project),
	}));
	return { tabs, revision: scope.revision, target: options.target ?? "current-session" };
}
