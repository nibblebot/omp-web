import { createSignal, For, onMount, Show, type Component } from "solid-js";
import { TOOL_CARD_MODES, TOOL_ROW_CHOICES, TRANSCRIPT_WIDTHS } from "../../prefs/display";
import { APPEARANCE_SDK_SETTINGS } from "../../prefs/settings";
import {
	currentFontSize,
	currentThemePreference,
	setTheme,
	stepFontSize,
	THEME_OPTIONS,
	type ThemePreference,
} from "../../prefs/theme";
import {
	refreshSettings,
	setDisplayPref,
	setSidebarSessionTitleLines,
	setSidebarTitleFirst,
	setSidebarUsage,
	state,
} from "../../state";
import { settingItem } from "../../store/settings";
import { SettingsGroup } from "../settings/SettingsGroup";
import { SettingsRow, SettingsRowLayout } from "../settings/SettingsRow";
import { SettingSegmented } from "../settings/controls/SettingSegmented";
import { SettingSelect } from "../settings/controls/SettingSelect";
import { SettingToggle } from "../settings/controls/SettingToggle";
import { MinusIcon, PlusIcon } from "../ui/icons";
import { Popover } from "../ui/Popover";

/** Surface width in px; the popover shrinks to fit a narrower viewport. */
const WIDTH = 360;

/**
 * The SDK display settings of one popover group (APPEARANCE_SDK_SETTINGS), rendered
 * as compact settings rows that write through `updateSetting` exactly as the settings
 * sheet did. Rows appear as the settings model loads; before then a note stands in,
 * since each row's control comes from the model.
 */
const SdkRows: Component<{ group: keyof typeof APPEARANCE_SDK_SETTINGS }> = (props) => (
	<>
		<Show when={state.settingsModel === null}>
			<p class="appearance-popover-note">
				{state.settingsLoading ? "Loading session settings…" : "Session settings unavailable."}
			</p>
		</Show>
		<For each={APPEARANCE_SDK_SETTINGS[props.group]}>
			{(path) => (
				<Show when={settingItem(path)}>{(item) => <SettingsRow item={item()} compact />}</Show>
			)}
		</For>
	</>
);

/**
 * The Appearance popover: the single home for web display settings, anchored to the
 * header's Appearance button (which owns and mounts it; never a ModalHost overlay, so
 * the transcript behind it stays visible for live preview). Groups, in order:
 * Theme & text, Transcript, Status, Motion, Sidebar. Scrolls when the viewport is short.
 *
 * Three kinds of row share the surface:
 * - SDK display settings (`SdkRows`): session settings, written with `updateSetting`.
 * - Browser display preferences (`state.display`, prefs/display.ts): written with
 *   `setDisplayPref`. A new one adds its row to the matching group here (see the
 *   header of prefs/display.ts) and its label to `WEB_UI_SEARCH_ROWS` (prefs/settings.ts)
 *   with `APPEARANCE_MENU_TAB`, so settings search and the palette reach it.
 * - Theme, font size and the sidebar toggles, which keep their own storage keys.
 */
export const AppearancePopover: Component<{
	/** The Appearance button that owns this popover; presses on it are not "outside". */
	anchor: HTMLElement;
	onClose: () => void;
}> = (props) => {
	// Theme and font size are localStorage-only (prefs/theme.ts), so these signals mirror them.
	const [theme, setThemeSignal] = createSignal<ThemePreference>(currentThemePreference());
	const [fontSize, setFontSize] = createSignal(currentFontSize());
	// The SDK rows need the model; like the settings sheet, refresh it on open.
	onMount(refreshSettings);

	return (
		<Popover
			anchor={props.anchor}
			onClose={props.onClose}
			label="Appearance"
			class="appearance-popover"
			width={WIDTH}
			side="below"
			align="end"
		>
			<h2 class="appearance-popover-title">Appearance</h2>
			<div class="appearance-popover-body">
				<SettingsGroup title="Theme & text">
					<SettingsRowLayout label="Theme" compact>
						<SettingSelect
							label="Theme"
							options={THEME_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
							value={theme()}
							onChange={(value) => setThemeSignal(setTheme(value as ThemePreference))}
						/>
					</SettingsRowLayout>
					<SettingsRowLayout label="Font Size" compact>
						<div class="settings-font">
							<button
								type="button"
								class="settings-control-btn"
								aria-label="Decrease font size"
								onClick={() => setFontSize(stepFontSize(-1))}
							>
								<MinusIcon />
							</button>
							<span class="settings-font-value">{fontSize()}</span>
							<button
								type="button"
								class="settings-control-btn"
								aria-label="Increase font size"
								onClick={() => setFontSize(stepFontSize(1))}
							>
								<PlusIcon />
							</button>
						</div>
					</SettingsRowLayout>
				</SettingsGroup>
				<SettingsGroup title="Transcript">
					{/* Browser display rows of this group (Width, Tool cards, Advisor) go here, above the SDK rows. */}
					<SettingsRowLayout label="Width" compact stacked>
						<SettingSegmented
							label="Width"
							options={TRANSCRIPT_WIDTHS.map((value) => ({
								value,
								label: value === "default" ? "Default" : value[0]!.toUpperCase() + value.slice(1),
							}))}
							value={state.display.width}
							onChange={(value) => {
								const width = TRANSCRIPT_WIDTHS.find((w) => w === value);
								if (width) setDisplayPref("width", width);
							}}
						/>
					</SettingsRowLayout>
					<SettingsRowLayout
						label="Tool Cards"
						description="Collapsed shows header-only cards, Consolidated one row per run of tool calls, Expanded the full cards. Ctrl+O shows everything for now."
						compact
						stacked
					>
						<SettingSegmented
							label="Tool Cards"
							options={TOOL_CARD_MODES.map((value) => ({
								value,
								label: value[0]!.toUpperCase() + value.slice(1),
							}))}
							value={state.display.toolCards}
							onChange={(value) => {
								const mode = TOOL_CARD_MODES.find((m) => m === value);
								if (mode) setDisplayPref("toolCards", mode);
							}}
						/>
					</SettingsRowLayout>
					<Show when={state.display.toolCards === "expanded"}>
						<SettingsRowLayout
							label="Tool Output Rows"
							description="Rows of output an expanded tool card shows before the rest is hidden."
							compact
							stacked
						>
							<SettingSegmented
								label="Tool Output Rows"
								options={TOOL_ROW_CHOICES.map((value) => ({
									value,
									label: value === "all" ? "All" : value,
								}))}
								value={state.display.toolRows}
								onChange={(value) => {
									const rows = TOOL_ROW_CHOICES.find((r) => r === value);
									if (rows) setDisplayPref("toolRows", rows);
								}}
							/>
						</SettingsRowLayout>
					</Show>
					<SettingsRowLayout label="Advisor" compact stacked>
						<SettingSegmented
							label="Advisor"
							options={[
								{ value: "collapsed", label: "Collapsed" },
								{ value: "expanded", label: "Expanded" },
							]}
							value={state.display.advisor}
							onChange={(value) =>
								setDisplayPref("advisor", value === "collapsed" ? "collapsed" : "expanded")
							}
						/>
					</SettingsRowLayout>
					<SdkRows group="Transcript" />
				</SettingsGroup>
				<SettingsGroup title="Status">
					<SdkRows group="Status" />
				</SettingsGroup>
				<SettingsGroup title="Motion">
					<SdkRows group="Motion" />
					<SettingsRowLayout label="Soft Fade" compact>
						<SettingToggle
							label="Soft Fade"
							checked={state.display.softFade}
							onChange={(checked) => setDisplayPref("softFade", checked)}
						/>
					</SettingsRowLayout>
				</SettingsGroup>
				<SettingsGroup title="Sidebar">
					<SettingsRowLayout label="Usage in Sidebar" compact>
						<SettingToggle
							label="Usage in Sidebar"
							checked={state.sidebarUsage}
							onChange={setSidebarUsage}
						/>
					</SettingsRowLayout>
					<SettingsRowLayout
						label="Two-Line Session Titles"
						description="Lets a roster row show up to two lines of its last session title instead of one. A short title still takes one line."
						compact
					>
						<SettingToggle
							label="Two-Line Session Titles"
							checked={state.sidebarSessionTitleLines === 2}
							onChange={(checked) => setSidebarSessionTitleLines(checked ? 2 : 1)}
						/>
					</SettingsRowLayout>
					<SettingsRowLayout
						label="Title-First Workspace Rows"
						description="Roster rows lead with the last session title; the branch moves to the git stats line in small gray text. Rows without a session title keep the branch first."
						compact
					>
						<SettingToggle
							label="Title-First Workspace Rows"
							checked={state.sidebarTitleFirst}
							onChange={setSidebarTitleFirst}
						/>
					</SettingsRowLayout>
				</SettingsGroup>
			</div>
		</Popover>
	);
};
