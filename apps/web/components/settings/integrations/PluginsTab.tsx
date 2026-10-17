import type { Component } from "solid-js";
import { InstalledTab } from "../InstalledTab";

/** Plugins: installs stay in the terminal (code runs with daemon permissions); enable, disable, and configure here. */
export const PluginsTab: Component = () => (
	<div class="integrations-tab integrations-plugins">
		<p class="integrations-hint">
			Install a plugin from a terminal with <code>omp plugin install &lt;package&gt;</code>.
			Installed plugins are listed below.
		</p>
		<InstalledTab />
	</div>
);
