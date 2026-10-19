/**
 * Process-global SDK singletons shared by the unattached fleet services
 * (settings panel, usage). Both are lazy: static fleet loading stays SDK-free,
 * and the SDK is only imported on first use.
 */

import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";

export interface SdkModelRegistry {
	readonly authStorage: AuthStorage;
	readonly registry: ModelRegistry;
}

let settingsInit: Promise<Settings> | null = null;
let modelRegistryInit: Promise<SdkModelRegistry> | null = null;

/**
 * The process-global Settings singleton. Settings.init is process-global and
 * idempotent (whoever initializes first wins), so an in-memory test instance
 * is used when present and nothing touches disk.
 */
export function ensureSettings(): Promise<Settings> {
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
				const settings = await Settings.init({ agentDir: getAgentDir() });
				// Edits to config.yml made by daemons or by hand must reach this view; the SDK CLI starts the same watch.
				settings.startWatching();
				return settings;
			}
		})();
	}
	return settingsInit;
}

/**
 * The process-global auth storage and ModelRegistry over discoverAuthStorage
 * (the agent dir's auth DB). Created once and shared by concurrent callers. A
 * failed creation is not cached, so the next caller retries.
 */
export function ensureModelRegistry(): Promise<SdkModelRegistry> {
	if (modelRegistryInit === null) {
		const init = (async (): Promise<SdkModelRegistry> => {
			const [{ discoverAuthStorage, ModelRegistry }, { getAgentDir }] = await Promise.all([
				import("@oh-my-pi/pi-coding-agent"),
				import("@oh-my-pi/pi-utils"),
			]);
			const authStorage = await discoverAuthStorage(getAgentDir());
			return { authStorage, registry: new ModelRegistry(authStorage) };
		})();
		modelRegistryInit = init;
		init.catch(() => {
			if (modelRegistryInit === init) modelRegistryInit = null;
		});
	}
	return modelRegistryInit;
}
