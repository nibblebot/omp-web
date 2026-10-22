import { Show, Switch, Match, type JSX } from "solid-js";
import { displayOptionValue, effectNote, unmetDependency } from "../../prefs/settings";
import { asRecord, controlKind, hasWideSelection, itemOptions } from "../../prefs/setting-controls";
import { settingValue, unsetSetting, updateSetting } from "../../store/settings";
import { state } from "../../state";
import { ResetIcon, WarningIcon } from "../ui/icons";
import { SettingJsonField } from "./controls/SettingJsonField";
import { SettingOrderedList } from "./controls/SettingOrderedList";
import { SettingProviderLimits } from "./controls/SettingProviderLimits";
import { SettingSegmented } from "./controls/SettingSegmented";
import { SettingSelect } from "./controls/SettingSelect";
import { SettingStepper } from "./controls/SettingStepper";
import { SettingTextField } from "./controls/SettingTextField";
import { SettingToggle } from "./controls/SettingToggle";
import type { SettingsItem } from "#lib/wire/protocol";

/**
 * Shared row layout: label (with changed dot), help text and an optional amber
 * warning on the left; the control, plus Reset when given, on the right.
 */
export function SettingsRowLayout(props: {
	label: string;
	description?: string;
	warning?: string;
	changed?: boolean;
	/** Set by project config: the value is read-only here. */
	setByProject?: boolean;
	/** Muted suffix at the end of the description line, for example "New sessions only." */
	note?: string;
	/** Text, secret, JSON and ordered-list rows: the control drops below the help text. */
	stacked?: boolean;
	children: JSX.Element;
	reset?: JSX.Element;
}) {
	return (
		<div class="settings-item" classList={{ changed: props.changed, stacked: props.stacked }}>
			<div class="settings-item-text">
				<Show when={props.warning}>
					<WarningIcon class="settings-item-warning-icon" />
				</Show>
				<div class="settings-item-label">
					<Show when={props.changed}>
						<span class="changed-dot" title="Changed from default" />
					</Show>
					<span>{props.label}</span>
				</div>
				<Show when={props.warning}>
					<p class="settings-item-warning" role="note">
						{props.warning}
					</p>
				</Show>
				<Show when={props.description || props.note}>
					<p class="settings-item-desc">
						{props.description}
						<Show when={props.note}>
							{props.description ? " · " : null}
							<span class="settings-item-note">{props.note}</span>
						</Show>
					</p>
				</Show>
				<Show when={props.setByProject}>
					<p class="settings-item-source">Set by project config</p>
				</Show>
			</div>
			<div class="settings-item-control">
				{props.reset}
				{props.children}
			</div>
		</div>
	);
}

/**
 * One settings row: the control is chosen by `controlKind`, and every write goes
 * through the store, which resolves the revision when it dispatches the write.
 */
export function SettingsRow(props: { item: SettingsItem }) {
	const item = () => props.item;
	const kind = () => controlKind(item());
	const setByProject = () => item().view?.source === "project";
	// SET-03: a default role with a thinking suffix overrides this default for that role.
	const rowWarning = (): string | undefined => {
		if (item().path !== "defaultThinkingLevel") return item().warning;
		const level = state.modelRoleCatalog?.find((entry) => entry.role === "default")?.thinkingLevel;
		if (!level) return item().warning;
		const note = `Role default uses ${level} from its :suffix; this setting applies only when the role has no suffix.`;
		return item().warning ? `${item().warning} ${note}` : note;
	};
	const blocked = () => unmetDependency(item().path, settingValue);

	return (
		<SettingsRowLayout
			label={item().label}
			description={item().description}
			warning={blocked() ?? rowWarning()}
			changed={item().changed}
			setByProject={setByProject()}
			note={effectNote(item().view?.effect) ?? undefined}
			stacked={
				kind() === "text" ||
				kind() === "secret" ||
				kind() === "json" ||
				kind() === "orderedList" ||
				(kind() === "select" && hasWideSelection(item()))
			}
			reset={
				<Show when={item().changed && item().view?.explicit?.layer === "global"}>
					<button
						type="button"
						class="settings-reset"
						aria-label="Reset to default"
						title="Reset to default"
						disabled={setByProject() || item().view?.canUnset === false}
						onClick={() => unsetSetting(item().path)}
					>
						<ResetIcon />
					</button>
				</Show>
			}
		>
			<Switch>
				<Match when={kind() === "toggle"}>
					<SettingToggle
						label={item().label}
						checked={item().value === true}
						disabled={setByProject() || blocked() !== null}
						onChange={(checked) => updateSetting(item().path, checked)}
					/>
				</Match>
				<Match when={kind() === "segmented"}>
					<SettingSegmented
						label={item().label}
						options={itemOptions(item())}
						value={displayOptionValue(item(), item().value)}
						disabled={setByProject()}
						onChange={(value) => updateSetting(item().path, value)}
					/>
				</Match>
				<Match when={kind() === "select"}>
					<SettingSelect
						label={item().label}
						options={itemOptions(item())}
						value={displayOptionValue(item(), item().value)}
						disabled={setByProject()}
						onChange={(value) => updateSetting(item().path, value)}
					/>
				</Match>
				<Match when={kind() === "stepper" || kind() === "number"}>
					<SettingStepper
						label={item().label}
						path={item().path}
						value={item().value}
						options={kind() === "stepper" ? item().options : undefined}
						disabled={setByProject()}
						onChange={(value) => updateSetting(item().path, value)}
					/>
				</Match>
				<Match when={kind() === "text" || kind() === "secret"}>
					<SettingTextField
						label={item().label}
						value={item().value}
						secret={kind() === "secret"}
						disabled={setByProject()}
						onCommit={(value) => updateSetting(item().path, value)}
					/>
				</Match>
				<Match when={kind() === "orderedList"}>
					<SettingOrderedList
						label={item().label}
						options={itemOptions(item())}
						selected={Array.isArray(item().value) ? (item().value as string[]) : []}
						disabled={setByProject()}
						onChange={(selected) => updateSetting(item().path, selected)}
					/>
				</Match>
				<Match when={kind() === "providerLimits"}>
					<SettingProviderLimits
						label={item().label}
						value={asRecord(item().value)}
						providers={item().providers ?? []}
						disabled={setByProject()}
						onCommit={(value) => updateSetting(item().path, value)}
					/>
				</Match>
				<Match when={kind() === "json"}>
					<SettingJsonField
						label={item().label}
						type={item().type === "list" ? "list" : "record"}
						value={item().value}
						disabled={setByProject()}
						onCommit={(value) => updateSetting(item().path, value)}
					/>
				</Match>
			</Switch>
		</SettingsRowLayout>
	);
}
