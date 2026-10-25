import { getKnownRoleIds } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import {
	applyModelPreset,
	findActiveModelPreset,
	type ModelPresetSession,
	type ModelPresetSwitchResult,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { cfgModelRoles } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";

/**
 * Model roles are sticky per running session, like its live model. Every
 * session watches config.yml (`initSettings`), so a role or preset written by
 * one session would otherwise move the roles, and the reported active preset,
 * of every session already running. A pin copies this process's effective roles
 * into its runtime override layer, which outranks every config layer: a `null`
 * entry is a tombstone that keeps a role this session has unset from appearing
 * when another session sets it. Writes still persist to config.yml for new
 * sessions; this session's own role writes update the pin.
 */
interface Pin {
	roles: Record<string, string | null>;
	/** Reads through `settings` with the thinking level this session started with
	 * (`defaultThinkingLevel` is read at session start), for preset matching. */
	presetView: Settings;
}

const pins = new WeakMap<Settings, Pin>();

function writePin(settings: Settings, roles: Record<string, string | null>): void {
	// The SDK types the record without the `null` tombstone its runtime layer honours
	// (Settings.getModelRoleProvenance), hence the cast.
	cfgModelRoles.override(settings, roles as Record<string, string>);
}

/** Pin this process to the roles config.yml gives now, and its default thinking level.
 * Called at session boot, before any session exists. */
export function pinModelRoles(settings: Settings): void {
	cfgModelRoles.clearOverride(settings);
	const effective = settings.getModelRoles();
	const roles: Record<string, string | null> = {};
	for (const role of new Set([...getKnownRoleIds(settings), ...Object.keys(effective)])) {
		roles[role] = effective[role] ?? null;
	}
	writePin(settings, roles);
	pins.set(settings, {
		roles,
		presetView: settings.overlay({ defaultThinkingLevel: cfgDefaultThinkingLevel.get(settings) }),
	});
}

/** A new conversation in a pinned session process starts from config.yml like a new session process does. */
export function retakeModelRolePin(settings: Settings): void {
	if (pins.has(settings)) pinModelRoles(settings);
}

/** Record this session's own write to `role` (hub edit or clear) in the pin. The
 * SDK rebuilds the runtime role map without tombstones on every role write. */
export function repinModelRole(settings: Settings, role: string): void {
	const pin = pins.get(settings);
	if (!pin) return;
	pin.roles[role] = settings.getModelRole(role) ?? null;
	writePin(settings, pin.roles);
}

/** Preset matching this session's pinned roles and starting thinking level. */
export function activeModelPreset(settings: Settings): string | undefined {
	return findActiveModelPreset(pins.get(settings)?.presetView ?? settings);
}

/**
 * Apply preset `name` through the SDK, which persists it to config.yml for new
 * sessions and switches this session live. The pin is lifted for the apply so
 * the SDK sees, writes and reports against the config layers, then re-taken
 * from the result; a refusal that wrote nothing, or a throw, restores the previous pin.
 */
export async function applyPinnedModelPreset(
	settings: Settings,
	session: ModelPresetSession,
	name: string,
): Promise<ModelPresetSwitchResult> {
	const previous = pins.get(settings);
	if (!previous) return applyModelPreset(settings, session, name);
	cfgModelRoles.clearOverride(settings);
	let written = false;
	try {
		const result = await applyModelPreset(settings, session, name);
		written = result.kind === "switched" || result.kind === "failed";
		return result;
	} finally {
		if (written) pinModelRoles(settings);
		else writePin(settings, previous.roles);
	}
}
