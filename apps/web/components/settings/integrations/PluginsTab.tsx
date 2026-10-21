import type { Component } from "solid-js";
import { InstalledTab } from "../InstalledTab";

/** Plugins: installs stay in the terminal (code runs with daemon permissions); enable, disable, and configure here. */
export const PluginsTab: Component = () => (
	<div class="integrations-tab integrations-plugins">
		<p class="integrations-hint">
			Install a plugin from a terminal with <code>omp plugin install &lt;package&gt;</code>.
			Installed plugins are listed below.
		</p>
		<p class="integrations-hint">
			Terminal UI parts of plugins do not run in the web: prompts get automatic answers such as "no"
			or empty, and custom panels do not appear. Tools, hooks, commands, and skills work normally.
		</p>
		<InstalledTab />
	</div>
);
