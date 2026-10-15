/**
 * Installed-plugin RPCs for an attached session. A fresh PluginManager per call:
 * its config cache is per instance, so a long-lived one would go stale against
 * the lock file. Writes are serialized so concurrent edits cannot interleave.
 */

import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";
import {
	getPluginConfig,
	listPlugins,
	parseFeatureSelection,
	type PluginStore,
	setPluginEnabled,
	setPluginFeatures,
	setPluginSetting,
} from "#lib/plugins/installed-plugins";
import type { PluginDetail, PluginSummary } from "#lib/wire/protocol";

export interface PluginMethods {
	listPlugins(args: unknown[]): Promise<PluginSummary[]>;
	getPluginConfig(args: unknown[]): Promise<PluginDetail>;
	setPluginEnabled(args: unknown[]): Promise<PluginDetail>;
	setPluginFeatures(args: unknown[]): Promise<PluginDetail>;
	setPluginSetting(args: unknown[]): Promise<PluginDetail>;
}

function pluginName(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) throw new Error("plugin name required");
	return value;
}

export function createPluginMethods(deps: { cwd: string }): PluginMethods {
	const store = (): PluginStore => new PluginManager(deps.cwd);
	let pending: Promise<unknown> = Promise.resolve();
	const mutate = <T>(run: () => Promise<T>): Promise<T> => {
		const next = pending.then(run, run);
		pending = next.catch(() => {});
		return next;
	};

	return {
		listPlugins: async () => listPlugins(store()),
		getPluginConfig: async (args) => getPluginConfig(store(), pluginName(args[0])),
		setPluginEnabled: (args) => {
			const name = pluginName(args[0]);
			const enabled = args[1];
			if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
			return mutate(() => setPluginEnabled(store(), name, enabled));
		},
		setPluginFeatures: (args) => {
			const name = pluginName(args[0]);
			const features = parseFeatureSelection(args[1]);
			return mutate(() => setPluginFeatures(store(), name, features));
		},
		setPluginSetting: (args) => {
			const name = pluginName(args[0]);
			const key = args[1];
			if (typeof key !== "string" || key.length === 0) throw new Error("setting key required");
			if (args.length < 3) throw new Error("setting value required (null clears it)");
			return mutate(() => setPluginSetting(store(), name, key, args[2]));
		},
	};
}
