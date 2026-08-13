import { settings, validateProviderMaxInFlightRequests } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getDefault,
	getType,
	SETTINGS_SCHEMA,
	SETTING_TABS,
	type SettingPath,
	type SettingTab,
	TAB_METADATA,
} from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getSettingsForTab, type SettingDef } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";
import { setExcludedSearchProviders, setSearchProviderOrder } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { isSearchProviderId } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { setImageProviderOrder } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import type { SettingsGroup, SettingsItem, SettingsModel, SettingsOption, SettingsTab } from "../shared/protocol";

// ---------------------------------------------------------------------------
// Server-side settings panel (TUI /settings parity).
//
// The web client's settings panel is driven by the same declarative metadata
// as the TUI: schema + UI defs from @oh-my-pi/pi-coding-agent. This module
// builds the wire SettingsModel, coerces incoming values exactly like the
// TUI's #setSettingValue, and replays the web-relevant subset of the TUI's
// handleSettingChange side effects on the live AgentSession. `settings` is
// the shared Settings singleton (Settings.instance) — settings.set() already
// updates the in-process merged view and persists (debounced) to disk, which
// IS the TUI semantics; this module never touches the filesystem itself.
// ---------------------------------------------------------------------------

/** Structural slice of AgentSession this module calls (kept narrow for testability). */
export interface AgentSessionLike {
	setSteeringMode(mode: "all" | "one-at-a-time"): void;
	setFollowUpMode(mode: "all" | "one-at-a-time"): void;
	setInterruptMode(mode: "immediate" | "wait"): void;
	setAdvisorEnabled(enabled: boolean): void;
	setThinkingLevel(level: never, persist?: boolean): void;
	refreshBaseSystemPrompt(): Promise<void>;
	applyMemoryBackend(): Promise<void>;
	applyInspectImageModeChange(): Promise<unknown>;
	agent: {
		temperature?: number;
		topP?: number;
		topK?: number;
		minP?: number;
		presencePenalty?: number;
		repetitionPenalty?: number;
		hideThinkingSummary?: boolean;
	};
}

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
 * Schema-driven value coercion, mirroring the TUI's #setSettingValue. Throws
 * Error on unknown/non-schema paths.
 */
export function coerceSettingValue(path: string, value: unknown): unknown {
	if (!(path in SETTINGS_SCHEMA)) throw new Error(`Unknown setting: ${path}`);
	const schemaType = getType(path as SettingPath);

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
			return validateProviderMaxInFlightRequests(parsed);
		}
		return parsed;
	}

	const currentValue = settings.get(path as SettingPath);
	if (typeof currentValue === "number") {
		const n = Number(value);
		if (!Number.isFinite(n)) throw new Error(`Invalid numeric value for ${path}`);
		return n;
	}
	if (typeof currentValue === "boolean") return value === true || value === "true";
	// Optional/credential strings start undefined (never set); the TUI's
	// fallback stores the raw input in that case — mirror it here.
	if (typeof currentValue === "string" || currentValue === undefined || currentValue === null) return String(value);
	if (Array.isArray(currentValue)) {
		return Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
	}
	throw new Error(`Unsupported setting type for ${path}`);
}

/**
 * Web-relevant subset of the TUI's handleSettingChange: session setters and
 * runtime preference updates. settings.set() (persist) already ran in the
 * caller for schema paths — this switch only applies live side effects, so
 * TUI-only rendering side effects are skipped and unknown paths are rejected
 * upstream by coerceSettingValue.
 */
export async function applySettingSideEffects(session: AgentSessionLike, path: string, value: unknown): Promise<void> {
	switch (path) {
		case "steeringMode":
			session.setSteeringMode(value as "all" | "one-at-a-time");
			break;
		case "followUpMode":
			session.setFollowUpMode(value as "all" | "one-at-a-time");
			break;
		case "interruptMode":
			session.setInterruptMode(value as "immediate" | "wait");
			break;
		case "advisor.enabled":
			session.setAdvisorEnabled(value === true);
			break;
		case "defaultThinkingLevel":
			session.setThinkingLevel(value as never, true);
			break;
		case "personality":
		case "tools.xdevDocs":
			await session.refreshBaseSystemPrompt();
			break;
		case "memory.backend":
			await session.applyMemoryBackend();
			break;
		case "inspect_image.mode":
			await session.applyInspectImageModeChange();
			break;
		case "temperature":
		case "topP":
		case "topK":
		case "minP":
		case "presencePenalty":
		case "repetitionPenalty": {
			const n = Number(value);
			session.agent[path] = n >= 0 ? n : undefined;
			break;
		}
		case "omitThinking":
			session.agent.hideThinkingSummary = value === true;
			break;
		case "providers.webSearchOrder":
			if (Array.isArray(value)) setSearchProviderOrder(value.filter(isSearchProviderId));
			break;
		case "providers.webSearchExclude":
			if (Array.isArray(value)) setExcludedSearchProviders(value.filter(isSearchProviderId));
			break;
		case "providers.imageOrder":
			if (Array.isArray(value)) setImageProviderOrder(value.filter(v => typeof v === "string"));
			break;
		// All other schema paths: persist-only (settings.set already applied).
	}
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
			...session.getAvailableThinkingLevels().map(level => {
				const existing = base.find(o => o.value === level);
				return existing ?? { value: level, label: level };
			}),
		];
	}
	if (def.path === "theme.dark" || def.path === "theme.light") {
		return themes.map(theme => ({ value: theme, label: theme }));
	}
	return def.options.map(o => ({ value: o.value, label: o.label, description: o.description }));
}

/** Structural slice of the session the model builder needs. */
export type SettingsSession = {
	getAvailableThinkingLevels(): readonly string[];
	getAvailableModels(): ReadonlyArray<{ provider: string }>;
};

function defToItem(def: SettingDef, session: SettingsSession, themes: string[], providers: string[]): SettingsItem {
	const value = settings.get(def.path);
	const base = {
		path: def.path,
		label: def.label,
		description: def.description,
		value,
		changed: settingChanged(value, getDefault(def.path)),
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
			return { ...base, type: "multiselect", options: [...def.options], ordered: def.ordered === true };
		case "providerLimits":
			return { ...base, type: "providerLimits", providers };
	}
}

function buildGroups(tab: SettingTab, session: SettingsSession, themes: string[], providers: string[]): SettingsGroup[] {
	// getSettingsForTab orders defs by TAB_GROUPS[tab] (ungrouped first, then
	// group order), so emitting a heading on group change reproduces the TUI's
	// section layout; groups that end up with zero visible items never appear.
	const groups: SettingsGroup[] = [];
	let current: SettingsGroup | null = null;
	for (const def of getSettingsForTab(tab)) {
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
	// providerLimits lists the session's providers, sorted unique (matches the
	// TUI's /settings provider picker).
	const providers = [...new Set(session.getAvailableModels().map(m => m.provider))].sort((a, b) => a.localeCompare(b));
	const tabs: SettingsTab[] = SETTING_TABS.map(tab => ({
		id: tab,
		label: TAB_METADATA[tab].label,
		groups: buildGroups(tab, session, themes, providers),
	}));
	return { tabs };
}
