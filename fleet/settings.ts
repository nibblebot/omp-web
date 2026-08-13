/**
 * Unattached-fleet settings service (roster-mode /ctl/settings).
 *
 * The session-scoped getSettings/setSetting RPCs need a live AgentSession
 * and fail unattached ("Settings unavailable"). This service backs the
 * settings panel while the fleet edge has no daemon attached: it lazily
 * initializes the process-global Settings singleton (the SAME instance a
 * session would read — any fleet settings path MUST use Settings.init, never
 * loadIsolated, or values render from the wrong instance), builds the wire
 * SettingsModel from the shared server/settings-model.ts metadata, and
 * persists coerced values without live session side effects.
 */

import { Settings, discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getAvailableThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { SettingsModel } from "../shared/protocol";
import { buildSettingsModel, coerceSettingValue, type SettingsSession } from "../server/settings-model";

/** The unattached settings surface the fleet control plane exposes. */
export interface FleetSettings {
	getModel(): Promise<SettingsModel>;
	set(path: string, value: unknown): Promise<SettingsModel>;
}

export interface FleetSettingsOptions {
	/**
	 * Provider source for the providerLimits row, injectable for tests.
	 * Defaults to a lazily-created ModelRegistry backed by
	 * discoverAuthStorage(getAgentDir()). A rejected factory degrades to an
	 * empty provider list — the settings request never fails because of it.
	 */
	registry?: () => Promise<ReadonlyArray<{ provider: string }>>;
}

export function createFleetSettings(options: FleetSettingsOptions = {}): FleetSettings {
	// Lazy shared singletons: Settings.init is process-global (idempotent —
	// whoever initialized first wins, so an in-memory test instance is used
	// and nothing touches disk) and the ModelRegistry is expensive, so both
	// are created once and shared by concurrent callers.
	let settingsInit: Promise<Settings> | null = null;
	let providers: Promise<ReadonlyArray<{ provider: string }>> | null = null;

	const ensureSettings = (): Promise<Settings> => {
		if (settingsInit === null) {
			settingsInit = (async () => {
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
		await ensureSettings();
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
		return buildSettingsModel(fallbackSession, themes);
	}

	async function set(path: string, value: unknown): Promise<SettingsModel> {
		const settings = await ensureSettings();
		// Schema-driven coercion mirrors the TUI's #setSettingValue; throws
		// on unknown paths / uncoercible values (the route maps those to 400).
		const coerced = coerceSettingValue(path, value);
		// Persist-only: no live session exists in roster mode, so
		// applySettingSideEffects (session setters, prompt refresh, memory
		// backend, …) is deliberately skipped — the side effects replay when
		// a session next boots from the same config, making the merged-view +
		// debounced-disk write the complete fleet-side action.
		settings.set(path as SettingPath, coerced as never);
		return getModel();
	}

	return { getModel, set };
}
