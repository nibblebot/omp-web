/**
 * Which installed plugin is calling. The SDK hands every extension of a session the same UI
 * context, so a `ctx.ui` call carries no caller: the only trace of it is the call stack, whose
 * frames name the files of the plugin that made the call. The known plugins are read from the
 * lock file at boot and after each plugin write this session makes; one changed from a terminal
 * or the fleet is seen at the next boot, which is also when its code is loaded or dropped.
 */

import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { PluginManager } from "@oh-my-pi/pi-coding-agent/extensibility/plugins";

export interface KnownPlugin {
	name: string;
	enabled: boolean;
	/** Directories its code runs from, each ending in a separator: the install path and its link target. */
	roots: string[];
}

// One session per process, so one list.
let known: KnownPlugin[] = [];

/** Replace the known plugins. */
export function setKnownPlugins(plugins: KnownPlugin[]): void {
	known = plugins;
}

/** Read the installed plugins of `cwd`. A missing or unreadable lock file means none. */
export async function refreshKnownPlugins(cwd: string): Promise<void> {
	try {
		const plugins = await new PluginManager(cwd).list();
		setKnownPlugins(
			await Promise.all(
				plugins.map(async (plugin) => {
					// A linked plugin's frames name the link target, not the path under node_modules.
					const target = await realpath(plugin.path).catch(() => plugin.path);
					return {
						name: plugin.name,
						enabled: plugin.enabled,
						roots: [...new Set([plugin.path, target])].map((root) => root + sep),
					};
				}),
			),
		);
	} catch (err) {
		console.error(`omp-session: could not read installed plugins: ${String(err)}`);
		setKnownPlugins([]);
	}
}

/** The known plugin whose code is nearest on the current call stack, if any. */
export function callerPlugin(): KnownPlugin | undefined {
	if (known.length === 0) return undefined;
	const stack = new Error().stack;
	if (stack === undefined) return undefined;
	for (const frame of stack.split("\n")) {
		for (const plugin of known) {
			if (plugin.roots.some((root) => frame.includes(root))) return plugin;
		}
	}
	return undefined;
}
