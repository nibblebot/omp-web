import { createSignal, For, Index, Match, Show, Switch, type Component } from "solid-js";
import type { PluginDetail, PluginFeatureRow, PluginSettingRow } from "#lib/wire/protocol";
import {
	pluginsError,
	setPluginEnabled,
	setPluginFeatures,
	setPluginSetting,
} from "../../../store/plugins";
import { ResetIcon } from "../../ui/icons";
import { SettingSelect } from "../controls/SettingSelect";
import { SettingToggle } from "../controls/SettingToggle";
import { SettingsGroup } from "../SettingsGroup";
import { SettingsRowLayout } from "../SettingsRow";

/**
 * Configure body for one plugin, expanded inline under its row in the Plugins tab (the
 * row already shows the name and meta line). It reuses the flat settings group
 * and row layout, so it lines up with every other settings list. Every control writes through the
 * store, which persists to the shared lock file; the store replaces the detail
 * with the server's answer. Secret values never reach the client, so a secret
 * field only reports whether a value is stored.
 */
export const PluginDetailView: Component<{ detail: PluginDetail | null }> = (props) => (
	<div class="plugin-detail">
		<Show when={pluginsError()}>
			<div class="settings-note">{pluginsError()}</div>
		</Show>
		<Show when={props.detail} keyed fallback={<div class="settings-note">Loading plugin…</div>}>
			{(detail) => <PluginBody detail={detail} />}
		</Show>
	</div>
);

const PluginBody: Component<{ detail: PluginDetail }> = (props) => (
	<>
		<SettingsGroup>
			<SettingsRowLayout label="Status" description={props.detail.enabled ? "Enabled" : "Disabled"}>
				<button
					type="button"
					class="settings-control-btn"
					onClick={() => setPluginEnabled(props.detail.name, !props.detail.enabled)}
				>
					{props.detail.enabled ? "Disable" : "Enable"}
				</button>
			</SettingsRowLayout>
		</SettingsGroup>
		<Show when={props.detail.features.length > 0}>
			<FeatureList detail={props.detail} />
		</Show>
		<Show when={props.detail.settings.length > 0}>
			<SettingsGroup title="Settings">
				<Index each={props.detail.settings}>
					{(row) => <SettingField plugin={props.detail.name} row={row()} />}
				</Index>
			</SettingsGroup>
		</Show>
	</>
);

const FeatureList: Component<{ detail: PluginDetail }> = (props) => {
	// Writes the full selection: every feature that is enabled after this toggle.
	const toggle = (feature: PluginFeatureRow) => {
		const selection = props.detail.features
			.filter((f) => (f.name === feature.name ? !f.enabled : f.enabled))
			.map((f) => f.name);
		setPluginFeatures(props.detail.name, selection);
	};
	return (
		<SettingsGroup title="Features">
			<For each={props.detail.features}>
				{(feature) => (
					<SettingsRowLayout label={feature.name} description={feature.description}>
						<SettingToggle
							label={feature.name}
							checked={feature.enabled}
							onChange={() => toggle(feature)}
						/>
					</SettingsRowLayout>
				)}
			</For>
			<Show when={props.detail.featuresCustomized}>
				<SettingsRowLayout
					label="Feature Selection"
					description="Customized from the plugin defaults."
				>
					<button
						type="button"
						class="settings-control-btn"
						onClick={() => setPluginFeatures(props.detail.name, null)}
					>
						Reset to Defaults
					</button>
				</SettingsRowLayout>
			</Show>
		</SettingsGroup>
	);
};

const SettingField: Component<{ plugin: string; row: PluginSettingRow }> = (props) => {
	// Booleans and secrets have their own clear paths; every other kind resets to its default here.
	const resettable = () =>
		!props.row.secret && props.row.type !== "boolean" && props.row.value !== undefined;
	return (
		<SettingsRowLayout
			label={props.row.key}
			description={props.row.description}
			note={props.row.env ? `Environment variable: ${props.row.env}` : undefined}
			changed={resettable()}
			stacked={props.row.secret || isTextRow(props.row)}
			reset={
				<Show when={resettable()}>
					<button
						type="button"
						class="settings-reset"
						aria-label="Reset to default"
						title="Reset to default"
						onClick={() => setPluginSetting(props.plugin, props.row.key, null)}
					>
						<ResetIcon />
					</button>
				</Show>
			}
		>
			<SettingControl plugin={props.plugin} row={props.row} />
		</SettingsRowLayout>
	);
};

/** Free-text rows: neither secret, boolean, enum nor number. */
const isTextRow = (row: PluginSettingRow): boolean =>
	row.type !== "boolean" && row.type !== "enum" && row.type !== "number";

const SettingControl: Component<{ plugin: string; row: PluginSettingRow }> = (props) => {
	const [draft, setDraft] = createSignal("");
	const key = () => props.row.key;
	const clear = () => setPluginSetting(props.plugin, key(), null);
	const current = () => props.row.value ?? props.row.default;
	return (
		<Switch>
			<Match when={props.row.secret}>
				<span class="plugin-stored">{props.row.set ? "Value stored" : "Not set"}</span>
				<input
					type="password"
					class="settings-text-input"
					aria-label={key()}
					autocomplete="off"
					placeholder="New value"
					value={draft()}
					onInput={(e) => setDraft(e.currentTarget.value)}
				/>
				<button
					type="button"
					class="settings-control-btn"
					disabled={draft() === ""}
					onClick={() => {
						setPluginSetting(props.plugin, key(), draft());
						setDraft("");
					}}
				>
					Save
				</button>
				<Show when={props.row.set}>
					<button type="button" class="settings-control-btn" onClick={clear}>
						Clear
					</button>
				</Show>
			</Match>
			<Match when={props.row.type === "boolean"}>
				<SettingToggle
					label={key()}
					checked={current() === true}
					onChange={(checked) => setPluginSetting(props.plugin, key(), checked)}
				/>
			</Match>
			<Match when={props.row.type === "enum"}>
				<SettingSelect
					label={key()}
					options={(props.row.values ?? []).map((value) => ({ value, label: value }))}
					value={String(current() ?? "")}
					onChange={(value) => setPluginSetting(props.plugin, key(), value)}
				/>
			</Match>
			<Match when={props.row.type === "number"}>
				<input
					type="number"
					class="settings-text-input plugin-number"
					aria-label={key()}
					min={props.row.min}
					max={props.row.max}
					step={props.row.step}
					value={current() === undefined ? "" : String(current())}
					onChange={(e) => {
						const text = e.currentTarget.value;
						if (text === "") {
							clear();
							return;
						}
						const n = Number(text);
						if (!Number.isFinite(n)) return;
						// Manifest bounds only; the server validates too. The input shows the bounded value.
						const bounded = Math.min(props.row.max ?? n, Math.max(props.row.min ?? n, n));
						e.currentTarget.value = String(bounded);
						setPluginSetting(props.plugin, key(), bounded);
					}}
				/>
			</Match>
			<Match when={true}>
				<input
					type="text"
					class="settings-text-input"
					aria-label={key()}
					value={current() === undefined ? "" : String(current())}
					onChange={(e) => {
						const text = e.currentTarget.value;
						if (text === "") clear();
						else setPluginSetting(props.plugin, key(), text);
					}}
				/>
			</Match>
		</Switch>
	);
};
