/**
 * Unattached-fleet settings service (the fleet control plane's /ctl/settings).
 *
 * The session-scoped getSettings/setSetting RPCs need a live AgentSession
 * and fail unattached ("Settings unavailable"). This service backs the
 * settings panel while the fleet edge has no daemon attached: it lazily
 * initializes the process-global Settings singleton (the SAME instance a
 * session would read; any fleet settings path MUST use Settings.init, never
 * loadIsolated, or values render from the wrong instance), builds the wire
 * SettingsModel from the shared lib/sdk-settings/settings-model.ts metadata, and
 * persists coerced values without live session side effects.
 */

import type { Settings } from "@oh-my-pi/pi-coding-agent";
import type { SettingsModel } from "#lib/wire/protocol";
import type { SettingsSession } from "#lib/sdk-settings/settings-model";

export type SettingsLayer = "global" | "project";

export class FleetSettingsError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 409,
	) {
		super(message);
	}
}

// All fleet services share the SDK singleton; revision checks and writes must
// remain ordered even when more than one service is instantiated.
let mutationQueue: Promise<unknown> = Promise.resolve();
/** The unattached settings surface the fleet control plane exposes. */
export interface FleetSettings {
	getModel(): Promise<SettingsModel>;
	set(
		path: string,
		value: unknown,
		expectedRevision?: number,
		layer?: SettingsLayer,
	): Promise<SettingsModel>;
	unset(path: string, expectedRevision?: number, layer?: SettingsLayer): Promise<SettingsModel>;
}

export interface FleetSettingsOptions {
	/**
	 * Provider source for the providerLimits row, injectable for tests.
	 * Defaults to a lazily-created ModelRegistry backed by
	 * discoverAuthStorage(getAgentDir()). A rejected factory degrades to an
	 * empty provider list; the settings request never fails because of it.
	 */
	registry?: () => Promise<ReadonlyArray<{ provider: string }>>;
}

export function createFleetSettings(options: FleetSettingsOptions = {}): FleetSettings {
	// Lazy shared singletons: Settings.init is process-global (idempotent,
	// whoever initialized first wins, so an in-memory test instance is used
	// and nothing touches disk) and the ModelRegistry is expensive, so both
	// are created once and shared by concurrent callers.
	let settingsInit: Promise<Settings> | null = null;
	let providers: Promise<ReadonlyArray<{ provider: string }>> | null = null;

	const ensureSettings = (): Promise<Settings> => {
		if (settingsInit === null) {
			settingsInit = (async () => {
				const [{ Settings }, { getAgentDir }] = await Promise.all([
					import("@oh-my-pi/pi-coding-agent"),
					import("@oh-my-pi/pi-utils"),
				]);
				try {
					return Settings.instance;
				} catch {
					// Not yet initialized in this process (no daemon/session
					// has run): boot the singleton against the agent dir.
					return Settings.init({ agentDir: getAgentDir() });
				}
			})();
		}
		return settingsInit;
	};

	const getProviders = (): Promise<ReadonlyArray<{ provider: string }>> => {
		if (providers === null) {
			providers = (async () => {
				try {
					if (options.registry) return await options.registry();
					const [{ discoverAuthStorage, ModelRegistry }, { getAgentDir }] = await Promise.all([
						import("@oh-my-pi/pi-coding-agent"),
						import("@oh-my-pi/pi-utils"),
					]);
					const authStorage = await discoverAuthStorage(getAgentDir());
					const registry = new ModelRegistry(authStorage);
					await registry.awaitBackgroundRefresh();
					return registry.getAvailable();
				} catch {
					// No auth storage / discovery failure: degrade to an
					// empty provider list rather than failing the request.
					return [];
				}
			})();
		}
		return providers;
	};

	async function getModel(): Promise<SettingsModel> {
		const settings = await ensureSettings();
		const [{ getAvailableThemes }, { buildSettingsModel }] = await Promise.all([
			import("@oh-my-pi/pi-coding-agent"),
			import("#lib/sdk-settings/settings-model"),
		]);
		// Resolve providers + themes once per build; the session slice is
		// static for the fleet (no attached session to query).
		const [models, themes] = await Promise.all([getProviders(), getAvailableThemes()]);
		const fallbackSession: SettingsSession = {
			// No live session: no thinking levels (submenuOptions merges the
			// schema's options behind a leading "auto") and providers come
			// from the shared ModelRegistry snapshot.
			getAvailableThinkingLevels: () => [],
			getAvailableModels: () => models,
		};
		return buildSettingsModel(fallbackSession, themes, {
			settings,
			target: "future-sessions",
			projectWritable: false,
		});
	}

	function mutate(
		path: string,
		value: unknown,
		expectedRevision: number | undefined,
		layer: SettingsLayer,
		remove: boolean,
	): Promise<SettingsModel> {
		const operation = mutationQueue.then(async () => {
			if (layer !== "global" && layer !== "project")
				throw new FleetSettingsError("Invalid settings layer", 400);
			if (
				expectedRevision !== undefined &&
				(!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
			)
				throw new FleetSettingsError("Invalid expectedRevision", 400);
			const settings = await ensureSettings();
			const [{ lookup }, { coerceSettingValue }] = await Promise.all([
				import("@oh-my-pi/pi-coding-agent/config/registry"),
				import("#lib/sdk-settings/settings-model"),
			]);
			if (expectedRevision !== undefined && settings.revision !== expectedRevision)
				throw new FleetSettingsError("Settings changed; refresh before editing.", 409);
			const setting = lookup(path);
			if (!setting) throw new FleetSettingsError(`Unknown setting: ${path}`, 400);
			let coerced: unknown;
			if (!remove) {
				try {
					coerced = coerceSettingValue(path, value, settings);
				} catch (error) {
					throw new FleetSettingsError(error instanceof Error ? error.message : String(error), 400);
				}
			}
			// Persist only: future sessions apply their own live side effects.
			// Project layer has no per-setting SDK write surface (only model-role
			// project values persist), so project writes refuse with guidance.
			if (layer === "project") {
				throw new FleetSettingsError(
					"Project-layer settings are read-only here: edit the project config file directly.",
					400,
				);
			} else {
				if (remove) setting.unset(settings);
				else setting.set(settings, coerced);
				await settings.flush();
			}
			return getModel();
		});
		mutationQueue = operation.catch(() => undefined);
		return operation;
	}

	function set(
		path: string,
		value: unknown,
		expectedRevision?: number,
		layer: SettingsLayer = "global",
	): Promise<SettingsModel> {
		return mutate(path, value, expectedRevision, layer, false);
	}

	function unset(
		path: string,
		expectedRevision?: number,
		layer: SettingsLayer = "global",
	): Promise<SettingsModel> {
		return mutate(path, undefined, expectedRevision, layer, true);
	}

	return { getModel, set, unset };
}
