import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { Settings, type RawSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	getAllSettingDefs,
	SETTING_TABS,
	type SettingDef,
	type SettingsDisplayEntry,
	type SettingTab,
	TAB_METADATA,
} from "@oh-my-pi/pi-tui/overlays/settings-defs";
import {
	ADVANCED_GROUP,
	ADVANCED_SETTING_PATHS,
	HIDDEN_SETTING_PATHS,
	TAB_SECTION_ORDER,
	WEB_TRUE_CONDITIONS,
} from "#lib/sdk-settings/settings-layout";
import { MAX_SETTING_VALUE_PATHS } from "#lib/wire/protocol";
import type {
	SettingsGroup,
	SettingsItem,
	SettingsModel,
	SettingsOption,
	SettingsTab,
	SettingValues,
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

/** Plain JSON object: not null, not an array. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * SDK descriptions can embed Nerd Font icons from the key-hint theme (the Escape
 * key glyph, for one). Private-use code points render as tofu in the web UI, so
 * they are dropped, along with the empty "()" they leave behind.
 */
const PRIVATE_USE_GLYPH = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

/** Remove private-use glyphs from a setting description. */
export function plainDescription(text: string): string {
	return text
		.replace(PRIVATE_USE_GLYPH, "")
		.replace(/\(\s*\)/g, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/**
 * True when the current value differs from the schema default. Arrays compare
 * length + elementwise (===); records compare structurally (an unset record
 * resolves to a fresh {} that never Object.is-matches its default); everything
 * else uses Object.is.
 */
export function settingChanged(current: unknown, defaultValue: unknown): boolean {
	if (Array.isArray(current) && Array.isArray(defaultValue)) {
		return (
			current.length !== defaultValue.length ||
			current.some((entry, index) => entry !== defaultValue[index])
		);
	}
	if (isPlainRecord(current) && (defaultValue === undefined || isPlainRecord(defaultValue))) {
		return JSON.stringify(current) !== JSON.stringify(defaultValue ?? {});
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
 * - defaultThinkingLevel: the session's live thinking levels when a session is
 *   attached (merged with the schema's labels); otherwise the schema's declared
 *   options (auto, minimal ... max). "auto" is always first.
 * - theme.dark / theme.light: the themes installed on this machine.
 */
function submenuOptions(
	def: SettingDef & { type: "submenu" },
	session: SettingsSession,
	themes: string[],
): SettingsOption[] {
	if (def.path === "defaultThinkingLevel") {
		const levels = session.getAvailableThinkingLevels();
		if (levels.length === 0)
			return def.options.map((o) => ({
				value: o.value,
				label: o.label,
				description: o.description && plainDescription(o.description),
			}));
		const base = def.options;
		return [
			{ value: "auto", label: "auto" },
			...levels.map((level) => {
				const existing = base.find((o) => o.value === level);
				return existing ?? { value: level, label: level };
			}),
		];
	}
	if (def.path === "theme.dark" || def.path === "theme.light") {
		return themes.map((theme) => ({ value: theme, label: theme }));
	}
	return def.options.map((o) => ({
		value: o.value,
		label: o.label,
		description: o.description && plainDescription(o.description),
	}));
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

/**
 * Settings that only take effect when a session starts. Every other visible row is
 * `live`: a running session picks the edit up through a settings listener, a tool-gate
 * reconcile, or a read at use time (lib/sdk-settings/test/live-setting-trace.ts holds the
 * per-row evidence; the exhaustiveness test keeps both lists complete). Evidence paths
 * are relative to @oh-my-pi/pi-coding-agent 18.12.6 `src/`.
 */
export const NEXT_SESSION_PATHS: Readonly<Record<string, true>> = {
	// Seeds a new session's level (sdk.ts:2137 pickInitialThinkingLevel, agent-session.ts:12559
	// on session switch); agent-session.ts:2772-2775 states it is deliberately not listened to.
	defaultThinkingLevel: true,
	// Read once into mcpDiscoverOptions (sdk.ts:2625) at construction; no listener, and
	// MCP reconnects reuse that captured option (mcp/manager.ts:670,732).
	"mcp.startupTimeoutMs": true,
	// Read by startup/new-session discovery only (discovery/custom-context-files.ts:36); the
	// SDK's own description says "Start a new session to load them" (session/context-settings.ts:58).
	"contextFiles.extra": true,
	// Entering plan mode on startup is decided at launch and after /new
	// (modes/interactive-mode.ts:642, main.ts:2441); no listener.
	"plan.defaultOnStartup": true,
	// Auto-start of a collab room runs at startup and on session change or guest restore
	// (collab/controller.ts:120,352; modes/interactive-mode.ts:2556).
	"collab.autoStart": true,
	// Telemetry export is initialised once at process startup (main.ts:2298); no listener.
	"telemetry.otlpExportEnabled": true,
};

/** When an edit to a setting reaches a running session; see NEXT_SESSION_PATHS. */
export function settingEffect(path: string): SettingView["effect"] {
	return Object.hasOwn(NEXT_SESSION_PATHS, path) ? "next-session" : "live";
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
		effect: settingEffect(path),
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
		description: plainDescription(def.description),
		warning: def.warning,
		value,
		changed: settingChanged(value, def.defaultValue),
		view,
	};
	const schema = lookup(def.path);
	if (schema?.type === "record" && def.type !== "providerLimits")
		return { ...base, type: "record" };
	// An array-valued TUI text row (contextFiles.extra) edits as a list; a text input would store [].
	if (def.type === "text" && Array.isArray(def.defaultValue)) return { ...base, type: "list" };
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

/**
 * Wire item for a host row the TUI has no def for (a number or an array with no
 * choices). Numbers edit as text, which coerceSettingValue accepts in string form;
 * arrays edit as a JSON list.
 */
function entryToItem(
	entry: SettingsDisplayEntry,
	ui: NonNullable<SettingsDisplayEntry["ui"]>,
	options: SettingsModelOptions,
	global: RawSettings,
	project: RawSettings,
): SettingsItem {
	const view = settingView(
		entry.path,
		options.settings ?? Settings.instance,
		options,
		global,
		project,
	);
	const base = {
		path: entry.path,
		label: ui.label,
		description: plainDescription(ui.description),
		warning: ui.warning,
		value: view.effective,
		changed: settingChanged(view.effective, entry.defaultValue),
		view,
	};
	return entry.type === "array"
		? { ...base, type: "list" }
		: { ...base, type: "text", secret: false };
}

/** SDK gate for a row. WEB_TRUE_CONDITIONS forces the terminal probes true for the web client. */
function rowVisible(entry: SettingsDisplayEntry): boolean {
	const name = entry.ui?.condition;
	if (name !== undefined && WEB_TRUE_CONDITIONS[entry.path] === name) return true;
	return entry.condition ? entry.condition() : true;
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
	const defs = new Map<string, SettingDef>(
		getAllSettingDefs(settingsHost.entries).map((def) => [def.path, def]),
	);
	// Visible rows bucketed by section. SDK order is kept inside each section.
	const buckets = new Map<string, SettingsItem[]>();
	for (const entry of settingsHost.entries) {
		const ui = entry.ui;
		if (!ui || ui.tab !== tab || HIDDEN_SETTING_PATHS[entry.path]) continue;
		if (!rowVisible(entry)) continue;
		const def = defs.get(entry.path);
		const item = def
			? defToItem(def, session, themes, providers, options, global, project)
			: entryToItem(entry, ui, options, global, project);
		const section = ADVANCED_SETTING_PATHS[entry.path] ? ADVANCED_GROUP : (ui.group ?? "");
		const items = buckets.get(section);
		if (items) items.push(item);
		else buckets.set(section, [item]);
	}
	// Ungrouped first, then the manifest's section order, then sections the manifest
	// does not list (new SDK sections, in SDK order), then Advanced last.
	const listed = TAB_SECTION_ORDER[tab] ?? [];
	const named = [...buckets.keys()].filter((name) => name !== ADVANCED_GROUP);
	const ordered = [
		...named.filter((name) => name === ""),
		...listed.filter((name) => buckets.has(name)),
		...named.filter((name) => name !== "" && !listed.includes(name)),
		...(buckets.has(ADVANCED_GROUP) ? [ADVANCED_GROUP] : []),
	];
	return ordered.map((name) => ({ name, items: buckets.get(name) ?? [] }));
}

/**
 * Optimistic-concurrency revision of the persisted settings: it moves only
 * when the global or project layer's content changes. The SDK's own
 * `Settings.revision` moves on every merge rebuild, including the config
 * watcher reloading a file this process just wrote, so a client holding the
 * revision a write answered with would be refused as stale on its next write.
 */
const contentRevisions = new WeakMap<
	Settings,
	{ sdkRevision: number; fingerprint: string; revision: number }
>();

export function settingsRevision(settings: Settings): number {
	const sdkRevision = settings.revision;
	const previous = contentRevisions.get(settings);
	if (previous?.sdkRevision === sdkRevision) return previous.revision;
	const fingerprint = canonicalJson([settings.getGlobalSettings(), settings.getProjectSettings()]);
	const revision =
		previous === undefined
			? sdkRevision
			: previous.fingerprint === fingerprint
				? previous.revision
				: previous.revision + 1;
	contentRevisions.set(settings, { sdkRevision, fingerprint, revision });
	return revision;
}

/** JSON with object keys sorted, so a reload that reorders keys keeps the fingerprint. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner !== null && typeof inner === "object" && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0,
					),
				)
			: inner,
	);
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
	return { tabs, revision: settingsRevision(scope), target: options.target ?? "current-session" };
}

/**
 * The effective value of each named setting, read the way a model row reads
 * its `value` (`layered`, never the credential-bearing `get`). A path the
 * registry does not know is omitted. This is `getSettings({ paths })`: a page
 * that needs a handful of settings at attach does not pay for the whole model.
 */
export function buildSettingValues(
	paths: readonly string[],
	options: SettingsModelOptions = {},
): SettingValues {
	const scope = options.settings ?? Settings.instance;
	const values: Record<string, unknown> = {};
	for (const path of paths) {
		const setting = lookup(path);
		if (setting) values[path] = setting.layered(scope);
	}
	return {
		revision: settingsRevision(scope),
		target: options.target ?? "current-session",
		values,
	};
}

/**
 * The `{ paths }` option of getSettings, or null when the caller asked for the
 * full model. A malformed option throws rather than silently answering the
 * 160 KB model to a caller that wanted a few values.
 */
export function settingValuePaths(option: unknown): string[] | null {
	if (option === null || typeof option !== "object" || !("paths" in option)) return null;
	const { paths } = option;
	if (
		!Array.isArray(paths) ||
		paths.length > MAX_SETTING_VALUE_PATHS ||
		!paths.every((path) => typeof path === "string")
	)
		throw new Error(`getSettings paths must be at most ${MAX_SETTING_VALUE_PATHS} strings.`);
	return paths;
}
