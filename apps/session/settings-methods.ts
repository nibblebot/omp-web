import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	buildSettingsModel,
	coerceSettingValue,
	type SettingsSession,
} from "#lib/sdk-settings/settings-model";
import type { SettingsModel } from "#lib/wire/protocol";
import { applySettingSideEffects, type AgentSessionLike } from "./settings-effects";

export interface SettingsEntry {
	session: SettingsSession &
		AgentSessionLike & {
			modelRegistry: { awaitBackgroundRefresh(): Promise<void> };
		};
}

export interface SettingsMethodsDeps {
	settings: Settings;
	getThemes(): Promise<string[]>;
	/** Broadcast the authoritative model to every attached session/tab sharing these settings. */
	broadcast(model: SettingsModel): void;
}

export interface SettingsMethods {
	getSettings(entry: SettingsEntry, args: unknown[]): Promise<SettingsModel>;
	setSetting(entry: SettingsEntry, args: unknown[]): Promise<SettingsModel>;
	unsetSetting(entry: SettingsEntry, args: unknown[]): Promise<SettingsModel>;
}

/** Settings writes are serialized so a stale client cannot race another browser mutation. */
export function createSettingsMethods(deps: SettingsMethodsDeps): SettingsMethods {
	let pending: Promise<unknown> = Promise.resolve();
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = pending.then(operation);
		pending = next.catch(() => undefined);
		return next;
	};
	const assertRevision = (revision: unknown) => {
		if (revision === undefined) return;
		if (!Number.isSafeInteger(revision) || revision !== deps.settings.revision)
			throw new Error("Settings changed; refresh before editing.");
	};
	const getSettings = async (entry: SettingsEntry): Promise<SettingsModel> => {
		await entry.session.modelRegistry.awaitBackgroundRefresh();
		return buildSettingsModel(entry.session, await deps.getThemes(), {
			settings: deps.settings,
			projectWritable: false,
		});
	};
	const mutate = (entry: SettingsEntry, args: unknown[], unset: boolean) =>
		serialize(async () => {
			if (typeof args[0] !== "string") throw new Error("Setting path must be a string.");
			const path = args[0];
			const setting = lookup(path);
			if (!setting) throw new Error(`Unknown setting: ${path}`);
			const revision = args[unset ? 1 : 2];
			const layer = args[unset ? 2 : 3] ?? "global";
			if (layer !== "global" && layer !== "project") throw new Error("Invalid settings layer.");
			assertRevision(revision);
			if (layer === "project") {
				throw new Error(
					"Project-layer settings are read-only in this daemon: the SDK exposes no per-setting project write surface (only model-role project values persist); edit the project config file directly.",
				);
			} else {
				if (unset) setting.unset(deps.settings);
				else setting.set(deps.settings, coerceSettingValue(path, args[1], deps.settings));
				await deps.settings.flush();
			}
			// Unset applies the inherited layered preference, not a null/default substitute.
			await applySettingSideEffects(entry.session, path, setting.layered(deps.settings));
			const model = await getSettings(entry);
			deps.broadcast(model);
			return model;
		});
	return {
		getSettings,
		setSetting: (entry, args) => mutate(entry, args, false),
		unsetSetting: (entry, args) => mutate(entry, args, true),
	};
}
