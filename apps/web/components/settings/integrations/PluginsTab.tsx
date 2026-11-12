import { createEffect, createMemo, createSignal, For, on, Show, type Component } from "solid-js";
import { BROWSER_UI_WIDGET_PREFIX, BROWSER_UI_WORKING_ID } from "#lib/wire/browser-ui-contract";
import { fleetSettingsActive, state } from "../../../state";
import {
	hiddenStatusBars,
	seenPluginStatusBars,
	setStatusBarHidden,
	statusBarId,
	statusBarPlugin,
} from "../../../store/browser-ui";
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
import { SettingToggle } from "../controls/SettingToggle";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRowLayout } from "../SettingsRow";
import { PluginDetailView } from "./PluginDetail";
import "./plugins.css";

/**
 * Plugins: installs stay in the terminal (code runs with session permissions);
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
			() => `${state.currentWorkspaceId ?? ""}|${fleetSettingsActive()}`,
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
			<StatusBars />
		</div>
	);
};

/** The heading a bar shows by the composer: "Status: key", "Widget: key" or "Working". */
function statusBarLabel(id: string): string {
	if (id === BROWSER_UI_WORKING_ID) return "Working";
	const kind = id.startsWith(BROWSER_UI_WIDGET_PREFIX) ? "Widget" : "Status";
	return `${kind}: ${id.slice(id.indexOf(":") + 1)}`;
}

/**
 * Status bars extensions set around the composer (`ctx.ui.setStatus`, line widgets from
 * `ctx.ui.setWidget`, the working message), one row each: those the attached session shows
 * now, with their text, and those hidden in this browser. Hiding one leaves its plugin running.
 * A row names the installed plugin the session traced the bar to; a bar of a disabled plugin
 * is not shown by the session, so its toggle is off and locked until the plugin is enabled.
 */
const StatusBars: Component = () => {
	// The bars the attached session shows, by contribution id.
	const live = createMemo(() => {
		const bars = new Map<string, { text: string; plugin: string | undefined }>();
		for (const request of state.browserUi.requests) {
			const id = statusBarId(request.contribution);
			if (id === undefined) continue;
			const block = request.contribution.payload.blocks[0];
			bars.set(id, {
				text: block?.type === "text" ? block.text : "",
				plugin: statusBarPlugin(request.contribution),
			});
		}
		return bars;
	});
	const pluginDisabled = (name: string | undefined) =>
		pluginSummaries().some((p) => p.name === name && !p.enabled);
	// Plain strings, so an update changes a row's text without remounting its toggle. A bar
	// the session took down because its plugin was disabled stays listed, locked.
	const ids = createMemo(() =>
		[
			...new Set([
				...live().keys(),
				...hiddenStatusBars().map((bar) => bar.id),
				...[...seenPluginStatusBars()].flatMap(([id, name]) => (pluginDisabled(name) ? [id] : [])),
			]),
		].sort(),
	);
	return (
		<Show when={ids().length > 0}>
			<p class="integrations-hint">
				Status bars are the status lines and widgets plugins show around the composer. Turning one
				off hides it in this browser; the plugin keeps running. A disabled plugin shows none.
			</p>
			<SettingsGroup title="Status Bars">
				<For each={ids()}>
					{(id) => {
						const isHidden = () => hiddenStatusBars().some((bar) => bar.id === id);
						const plugin = () =>
							live().get(id)?.plugin ??
							hiddenStatusBars().find((bar) => bar.id === id)?.plugin ??
							seenPluginStatusBars().get(id);
						const disabled = () => pluginDisabled(plugin());
						const description = () => {
							if (disabled()) return `${plugin()} is disabled`;
							const text = live().get(id)?.text ?? "Not set by this session";
							return plugin() === undefined ? text : `${plugin()} · ${text}`;
						};
						return (
							<SettingsRowLayout label={statusBarLabel(id)} description={description()}>
								<SettingToggle
									label={`Show ${statusBarLabel(id)}`}
									checked={!isHidden() && !disabled()}
									disabled={disabled()}
									onChange={(checked) => setStatusBarHidden(id, !checked, plugin())}
								/>
							</SettingsRowLayout>
						);
					}}
				</For>
			</SettingsGroup>
		</Show>
	);
};
