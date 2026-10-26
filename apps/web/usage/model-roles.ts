import type {
	ModelBrowserEntry,
	ModelPresetDetail,
	ModelPresetSource,
	ModelRoleCatalogEntry,
	WebSessionState,
} from "#lib/wire/protocol";

/** Thinking levels a role value can carry as a `:level` suffix (a model id may itself contain `:`). */
const LEVEL_SUFFIX_RE = /^(.+):(off|minimal|low|medium|high|xhigh|max|auto)$/;

/** Split `provider/id[:level]` into the model selector and its explicit thinking level. */
export function splitRoleValue(value: string): { model: string; level?: string } {
	const match = LEVEL_SUFFIX_RE.exec(value);
	return match ? { model: match[1], level: match[2] } : { model: value };
}

/** `provider/id` of a catalog entry; undefined when the role is unassigned. */
export function roleSelector(entry: ModelRoleCatalogEntry): string | undefined {
	return entry.provider && entry.id ? `${entry.provider}/${entry.id}` : undefined;
}

/** What a role shows: its resolved `provider/id`, the configured value marked unavailable when
 * it resolves to no available model, or undefined when the role is unassigned. */
export function roleDisplay(entry: ModelRoleCatalogEntry): string | undefined {
	return roleSelector(entry) ?? (entry.value ? `${entry.value} (unavailable)` : undefined);
}

/** Roles in sidebar order: visible roles in catalog order, hidden roles last. */
export function sortedRoles(catalog: readonly ModelRoleCatalogEntry[]): ModelRoleCatalogEntry[] {
	return [...catalog.filter((r) => !r.hidden), ...catalog.filter((r) => r.hidden)];
}

/** Thinking efforts the model supports; empty when it is unknown or does not reason. */
export function modelThinkingEfforts(
	browser: readonly ModelBrowserEntry[],
	selector: string | undefined,
): readonly string[] {
	if (selector === undefined) return [];
	const row = browser.find((m) => `${m.provider}/${m.id}` === selector);
	return row?.thinkingEfforts ?? [];
}

/** One role of a preset, with what the live roles hold when that differs. */
export interface PresetRoleRow {
	role: string;
	/** Visible row label: the role's tag, else its name (the role id for a role the catalog lacks). */
	label: string;
	model: string;
	level?: string;
	/** Configured live value or "unassigned" when it differs from the preset; absent when it matches. */
	current?: string;
}

/**
 * Rows for a preset's roles: roles the catalog knows come first in catalog order,
 * then unknown roles alphabetically. `compare` marks rows whose live assignment
 * differs (pass false for the active preset, which matches by definition).
 */
export function presetRoleRows(
	preset: ModelPresetDetail,
	catalog: readonly ModelRoleCatalogEntry[],
	compare: boolean,
): PresetRoleRow[] {
	const known = catalog.filter((entry) => preset.modelRoles[entry.role] !== undefined);
	const knownRoles = new Set(known.map((entry) => entry.role));
	const unknown = Object.keys(preset.modelRoles)
		.filter((role) => !knownRoles.has(role))
		.sort();
	const rows: PresetRoleRow[] = [];
	for (const entry of known) {
		rows.push(presetRow(entry.role, entry, preset.modelRoles[entry.role], compare));
	}
	for (const role of unknown) rows.push(presetRow(role, undefined, preset.modelRoles[role], false));
	return rows;
}

function presetRow(
	role: string,
	entry: ModelRoleCatalogEntry | undefined,
	value: string,
	compare: boolean,
): PresetRoleRow {
	const { model, level } = splitRoleValue(value);
	const live = entry?.value;
	return {
		role,
		label: roleLabel(entry ?? { name: role }),
		model,
		level,
		current: compare && live !== value ? (live ?? "unassigned") : undefined,
	};
}

const PRESET_SOURCE_LABEL: Record<Exclude<ModelPresetSource, "global">, string> = {
	project: "project",
	overlay: "--config",
	runtime: "runtime",
};

/** Badge text for a preset owned by a layer other than global; undefined for a global preset. */
export function presetSourceLabel(preset: ModelPresetDetail): string | undefined {
	return preset.source === "global" ? undefined : PRESET_SOURCE_LABEL[preset.source];
}

/** Where a non-global preset must be edited, for tooltips. */
const PRESET_SOURCE_OWNER: Record<Exclude<ModelPresetSource, "global">, string> = {
	project: "the project config",
	overlay: "the --config overlay",
	runtime: "the runtime settings",
};

/** Tooltip for an action only a global preset allows; undefined when allowed. */
export function presetLockReason(
	preset: ModelPresetDetail,
	action: "delete" | "update",
): string | undefined {
	if (preset.source !== "global") {
		return `Defined in ${PRESET_SOURCE_OWNER[preset.source]}. Edit it there; the web only ${action === "delete" ? "deletes" : "updates"} global presets.`;
	}
	if (action === "update" && preset.invalid !== undefined) {
		return "This preset is malformed. Fix it in config or delete it.";
	}
	return undefined;
}

/** The status-bar preset chip's label: the active preset, "custom" when presets exist but none
 * matches the roles, "presets" when none exist. */
export function presetSegmentLabel(presets: WebSessionState["modelPresets"]): string {
	if (presets?.active !== undefined) return presets.active;
	return (presets?.names.length ?? 0) > 0 ? "custom" : "presets";
}

/** Below 768px a tab shows either its list or the chosen item's detail; wider layouts show both. */
export type ModelDialogPane = "list" | "detail";

/** What a role is called in the UI: its tag ("SMOL"), or its name for a custom role without one. */
export function roleLabel(entry: { tag?: string; name: string }): string {
	return entry.tag ?? entry.name;
}
