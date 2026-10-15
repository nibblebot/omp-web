import { createEffect, createSignal, For, on, Show, type Component } from "solid-js";
import { fleetSettingsActive, state } from "../../state";
import {
	closePlugin,
	openPlugin,
	pluginDetail,
	pluginMetaLine,
	pluginSummaries,
	pluginsError,
	pluginsLoading,
	refreshPlugins,
} from "../../store/plugins";
import "./installed.css";
import { PluginDetailView } from "./PluginDetail";

/**
 * Settings > Installed: plugins from the shared lock file, one card each with
 * Configure. Lists reload whenever the target changes (session attach or
 * detach, fleet mode switch) so a card never shows another target's plugins.
 */
export const InstalledTab: Component = () => {
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

	const configure = (name: string) => {
		setSelected(name);
		openPlugin(name);
	};

	const back = () => {
		setSelected(null);
		closePlugin();
	};

	return (
		<Show
			when={selected() === null}
			fallback={<PluginDetailView detail={pluginDetail()} onBack={back} />}
		>
			<div class="installed-tab">
				<Show when={pluginsError()}>
					<div class="settings-note">{pluginsError()}</div>
				</Show>
				<Show when={!pluginsLoading() && pluginSummaries().length === 0}>
					<div class="settings-note">No plugins installed.</div>
				</Show>
				<h3 class="settings-group-title">Installed</h3>
				<For each={pluginSummaries()}>
					{(plugin) => (
						<div class="installed-card">
							<div class="installed-card-body">
								<span class="installed-card-name">{plugin.name}</span>
								<span class="installed-card-meta">{pluginMetaLine(plugin)}</span>
								<Show when={plugin.description}>
									<p class="installed-card-desc">{plugin.description}</p>
								</Show>
							</div>
							<button
								type="button"
								class="settings-control-btn"
								onClick={() => configure(plugin.name)}
							>
								Configure
							</button>
						</div>
					)}
				</For>
			</div>
		</Show>
	);
};
