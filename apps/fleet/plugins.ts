/**
 * Unattached-fleet Installed-plugin service (the fleet control plane's /ctl/plugins).
 *
 * Plugin state lives in the plugins lock file, not in a session, so the fleet
 * reads and writes it directly through the SDK PluginManager, the same backend
 * a session uses. The SDK loads lazily: static fleet loading stays SDK-free and
 * only plugin routes pay for it. A fresh PluginManager per call keeps its config
 * cache from going stale against the lock file. Writes share one queue so they
 * cannot interleave.
 */

import {
	getPluginConfig,
	listPlugins,
	type PluginStore,
	setPluginEnabled,
	setPluginFeatures,
	setPluginSetting,
} from "#lib/plugins/installed-plugins";
import type { PluginDetail, PluginSummary } from "#lib/wire/protocol";

export interface FleetPlugins {
	list(): Promise<PluginSummary[]>;
	get(name: string): Promise<PluginDetail>;
	setEnabled(name: string, enabled: boolean): Promise<PluginDetail>;
	setFeatures(name: string, features: string[] | null): Promise<PluginDetail>;
	setSetting(name: string, key: string, value: unknown): Promise<PluginDetail>;
}

interface FleetPluginsOptions {
	/** Plugin store source, injectable for tests (must not touch the real lock file). */
	openStore?: () => Promise<PluginStore>;
}

async function defaultStore(): Promise<PluginStore> {
	// Lazy on purpose: the SDK pulls in the agent runtime, and the fleet's static load path must not.
	const { PluginManager } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins");
	return new PluginManager();
}

// Every fleet plugin service shares the lock file: keep writes ordered.
let mutationQueue: Promise<unknown> = Promise.resolve();

function mutate<T>(run: () => Promise<T>): Promise<T> {
	const next = mutationQueue.then(run, run);
	mutationQueue = next.catch(() => {});
	return next;
}

export function createFleetPlugins(options: FleetPluginsOptions = {}): FleetPlugins {
	const openStore = options.openStore ?? defaultStore;
	return {
		list: async () => listPlugins(await openStore()),
		get: async (name) => getPluginConfig(await openStore(), name),
		setEnabled: (name, enabled) =>
			mutate(async () => setPluginEnabled(await openStore(), name, enabled)),
		setFeatures: (name, features) =>
			mutate(async () => setPluginFeatures(await openStore(), name, features)),
		setSetting: (name, key, value) =>
			mutate(async () => setPluginSetting(await openStore(), name, key, value)),
	};
}
