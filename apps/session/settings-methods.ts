import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import {
	buildSettingsModel,
	coerceSettingValue,
	settingsRevision,
	type SettingsSession,
} from "#lib/sdk-settings/settings-model";
import type { SettingsModel, SettingsRevisionAck } from "#lib/wire/protocol";
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
	setSetting(entry: SettingsEntry, args: unknown[]): Promise<SettingsModel | SettingsRevisionAck>;
	unsetSetting(entry: SettingsEntry, args: unknown[]): Promise<SettingsModel | SettingsRevisionAck>;
}

export interface SettingsMethodsBundle {
	methods: SettingsMethods;
	/** Rebroadcast the model after a change made outside these RPCs (session toggles). */
	publish(entry: SettingsEntry): Promise<SettingsModel>;
}

/** Settings writes are serialized so a stale client cannot race another browser mutation. */
export function createSettingsMethods(deps: SettingsMethodsDeps): SettingsMethodsBundle {
	let pending: Promise<unknown> = Promise.resolve();
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = pending.then(operation);
		pending = next.catch(() => undefined);
		return next;
	};
	const assertRevision = (revision: unknown) => {
		if (revision === undefined) return;
		if (!Number.isSafeInteger(revision) || revision !== settingsRevision(deps.settings))
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
			const replyWithRevision = args[unset ? 3 : 4] === "revision";
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
			await applySettingSideEffects(entry.session, path);
			const model = await getSettings(entry);
			deps.broadcast(model);
			return replyWithRevision
				? { revision: model.revision ?? settingsRevision(deps.settings) }
				: model;
		});
	const publish = async (entry: SettingsEntry): Promise<SettingsModel> => {
		const model = await getSettings(entry);
		deps.broadcast(model);
		return model;
	};
	return {
		methods: {
			getSettings,
			setSetting: (entry, args) => mutate(entry, args, false),
			unsetSetting: (entry, args) => mutate(entry, args, true),
		},
		publish,
	};
}
