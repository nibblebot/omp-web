import { createSignal, For, Index, Match, Show, Switch, type Component } from "solid-js";
import type { PluginDetail, PluginFeatureRow, PluginSettingRow } from "#lib/wire/protocol";
import {
	pluginMetaLine,
	pluginsError,
	setPluginEnabled,
	setPluginFeatures,
	setPluginSetting,
} from "../../store/plugins";
import { SettingsGroup } from "./SettingsGroup";
import { SettingSelect } from "./controls/SettingSelect";
import { SettingToggle } from "./controls/SettingToggle";

/**
 * Configure view for one plugin. Every control writes through the store, which
 * persists to the shared lock file; the store replaces the detail with the
 * server's answer. Secret values never reach the client, so a secret field
 * only reports whether a value is stored.
 */
export const PluginDetailView: Component<{ detail: PluginDetail | null; onBack: () => void }> = (
	props,
) => (
	<div class="installed-detail">
		<button type="button" class="settings-control-btn" onClick={props.onBack}>
			Back
		</button>
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
		<div class="installed-detail-head">
			<span class="installed-card-name">{props.detail.name}</span>
			<span class="installed-card-meta">{pluginMetaLine(props.detail)}</span>
		</div>
		<div class="installed-setting-controls">
			<button
				type="button"
				class="settings-control-btn"
				onClick={() => setPluginEnabled(props.detail.name, !props.detail.enabled)}
			>
				{props.detail.enabled ? "Disable" : "Enable"}
			</button>
		</div>
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
					<div class="installed-option">
						<SettingToggle
							label={feature.name}
							checked={feature.enabled}
							onChange={() => toggle(feature)}
						/>
						<span class="installed-option-name">{feature.name}</span>
						<Show when={feature.description}>
							<span class="installed-option-desc">{feature.description}</span>
						</Show>
					</div>
				)}
			</For>
			<Show when={props.detail.featuresCustomized}>
				<div class="installed-setting-controls">
					<button
						type="button"
						class="settings-control-btn"
						onClick={() => setPluginFeatures(props.detail.name, null)}
					>
						Reset to defaults
					</button>
				</div>
			</Show>
		</SettingsGroup>
	);
};

const SettingField: Component<{ plugin: string; row: PluginSettingRow }> = (props) => (
	<div class="installed-setting">
		<div class="installed-setting-head">
			<span class="installed-option-name">{props.row.key}</span>
			<Show when={props.row.description}>
				<span class="installed-option-desc">{props.row.description}</span>
			</Show>
			<Show when={props.row.env}>
				<span class="installed-option-desc">Environment variable: {props.row.env}</span>
			</Show>
		</div>
		<SettingControl plugin={props.plugin} row={props.row} />
	</div>
);

const SettingControl: Component<{ plugin: string; row: PluginSettingRow }> = (props) => {
	const [draft, setDraft] = createSignal("");
	const key = () => props.row.key;
	const clear = () => setPluginSetting(props.plugin, key(), null);
	const current = () => props.row.value ?? props.row.default;
	return (
		<Switch>
			<Match when={props.row.secret}>
				<div class="installed-setting-controls">
					<span class="installed-stored">{props.row.set ? "Value stored" : "Not set"}</span>
					<input
						type="password"
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
				</div>
			</Match>
			<Match when={props.row.type === "boolean"}>
				<SettingToggle
					label={key()}
					checked={current() === true}
					onChange={(checked) => setPluginSetting(props.plugin, key(), checked)}
				/>
			</Match>
			<Match when={props.row.type === "enum"}>
				<div class="installed-setting-controls">
					<SettingSelect
						label={key()}
						options={(props.row.values ?? []).map((value) => ({ value, label: value }))}
						value={String(current() ?? "")}
						onChange={(value) => setPluginSetting(props.plugin, key(), value)}
					/>
					<Show when={props.row.value !== undefined}>
						<button type="button" class="settings-control-btn" onClick={clear}>
							Reset to default
						</button>
					</Show>
				</div>
			</Match>
			<Match when={props.row.type === "number"}>
				<div class="installed-setting-controls">
					<input
						type="number"
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
					<Show when={props.row.value !== undefined}>
						<button type="button" class="settings-control-btn" onClick={clear}>
							Reset to default
						</button>
					</Show>
				</div>
			</Match>
			<Match when={true}>
				<div class="installed-setting-controls">
					<input
						type="text"
						value={current() === undefined ? "" : String(current())}
						onChange={(e) => {
							const text = e.currentTarget.value;
							if (text === "") clear();
							else setPluginSetting(props.plugin, key(), text);
						}}
					/>
					<Show when={props.row.value !== undefined}>
						<button type="button" class="settings-control-btn" onClick={clear}>
							Reset to default
						</button>
					</Show>
				</div>
			</Match>
		</Switch>
	);
};
