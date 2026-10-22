import { createEffect, createSignal, For, on, Show, type Component } from "solid-js";
import { fleetSettingsActive, state } from "../../../state";
import {
	closePlugin,
	openPlugin,
	pluginDetail,
	pluginMetaLine,
	pluginSummaries,
	pluginsError,
	pluginsLoading,
	refreshPlugins,
} from "../../../store/plugins";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRowLayout } from "../SettingsRow";
import { PluginDetailView } from "./PluginDetail";
import "./plugins.css";

/**
 * Plugins: installs stay in the terminal (code runs with daemon permissions);
 * enable, disable, and configure here. Plugins come from the shared lock file,
 * one flat settings row each with Configure, which expands the plugin's detail
 * inline under its row. The list reloads whenever the target changes (session
 * attach or detach, fleet mode switch) so a row never shows another target's
 * plugins.
 */
export const PluginsTab: Component = () => {
	const [selected, setSelected] = createSignal<string | null>(null);

	createEffect(
		on(
			() => `${state.currentSessionId ?? ""}|${fleetSettingsActive()}`,
			() => {
				setSelected(null);
				closePlugin();
				refreshPlugins();
			},
		),
	);

	// One plugin is open at a time (the store holds a single detail); Configure on the open one closes it.
	const toggleConfigure = (name: string) => {
		if (selected() === name) {
			setSelected(null);
			closePlugin();
			return;
		}
		setSelected(name);
		openPlugin(name);
	};

	return (
		<div class="integrations-tab integrations-plugins">
			<p class="integrations-hint">
				Install a plugin from a terminal with <code>omp plugin install &lt;package&gt;</code>.
				Installed plugins are listed below.
			</p>
			<p class="integrations-hint">
				Terminal UI parts of plugins do not run in the web: prompts get automatic answers such as
				"no" or empty, and custom panels do not appear. Tools, hooks, commands, and skills work
				normally.
			</p>
			<Show when={pluginsError() && selected() === null}>
				<div class="settings-note">{pluginsError()}</div>
			</Show>
			<Show when={!pluginsLoading() && pluginSummaries().length === 0}>
				<div class="settings-note">No plugins installed.</div>
			</Show>
			<Show when={pluginSummaries().length > 0}>
				<SettingsGroup>
					<For each={pluginSummaries()}>
						{(plugin) => (
							<div class="plugin-item">
								<SettingsRowLayout
									label={plugin.name}
									description={[pluginMetaLine(plugin), plugin.description]
										.filter(Boolean)
										.join(" · ")}
								>
									<button
										type="button"
										class="settings-control-btn"
										aria-expanded={selected() === plugin.name}
										onClick={() => toggleConfigure(plugin.name)}
									>
										{selected() === plugin.name ? "Close" : "Configure"}
									</button>
								</SettingsRowLayout>
								<Show when={selected() === plugin.name}>
									<PluginDetailView detail={pluginDetail()} />
								</Show>
							</div>
						)}
					</For>
				</SettingsGroup>
			</Show>
		</div>
	);
};
