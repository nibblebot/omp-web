import { createEffect, createSignal, For, on, onCleanup, Show, type Component } from "solid-js";
import {
	ENTER_KEY_CHOICES,
	TOOL_CARD_MODES,
	TOOL_ROW_CHOICES,
	TRANSCRIPT_WIDTHS,
} from "../../prefs/display";
import { APPEARANCE_SDK_SETTINGS } from "../../prefs/settings";
import { currentFontSize, stepFontSize } from "../../prefs/theme";
import {
	setDisplayPref,
	setSidebarSessionTitleLines,
	setSidebarTitleFirst,
	setSidebarUsage,
	state,
} from "../../state";
import { holdSettingsModel, settingItem } from "../../store/settings";
import { SettingsGroup } from "../settings/SettingsGroup";
import { SettingsRow, SettingsRowLayout } from "../settings/SettingsRow";
import { SettingSegmented } from "../settings/controls/SettingSegmented";
import { SettingToggle } from "../settings/controls/SettingToggle";
import { MinusIcon, PlusIcon } from "../ui/icons";
import { Modal } from "../ui/Modal";
import { ThemeFilesFooter } from "./ThemeFilesFooter";
import { ThemeLinkButton } from "./ThemeLinkButton";
import { ThemeModeControl } from "./ThemeModeControl";
import { ThemePicker } from "./ThemePicker";

/**
 * The SDK display settings of one sheet group (APPEARANCE_SDK_SETTINGS), rendered
 * as compact settings rows that write through `updateSetting` exactly as the settings
 * sheet did. Rows appear as the settings model loads; before then a note stands in,
 * since each row's control comes from the model.
 */
const SdkRows: Component<{ group: keyof typeof APPEARANCE_SDK_SETTINGS }> = (props) => (
	<>
		<Show when={state.settingsModel === null}>
			<p class="appearance-sheet-note">
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
 * The Appearance sheet: the single home for web display settings, a right side sheet
 * (`state.modal === "appearance"`, ModalHost mounts it) opened by the header's Appearance
 * button, the palette and settings search. Separate from the Settings sheet. Groups, in
 * order: Theme & text, Transcript, Status, Composer, Motion, Sidebar; the body scrolls.
 *
 * Three kinds of row share the surface:
 * - SDK display settings (`SdkRows`): session settings, written with `updateSetting`.
 * - Browser display preferences (`state.display`, prefs/display.ts): written with
 *   `setDisplayPref`. A new one adds its row to the matching group here (see the
 *   header of prefs/display.ts) and its label to `WEB_UI_SEARCH_ROWS` (prefs/settings.ts)
 *   with `APPEARANCE_MENU_TAB`, so settings search and the palette reach it.
 * - Theme (Mode, the theme picker with its link toggle, and the themes footer with Reload
 *   themes), font size and the sidebar toggles. Mode and theme selection are browser-only
 *   (prefs/theme.ts), written through the store's theme actions; the themes themselves
 *   come from the fleet (`state.themes`). Linked, one picker sets a theme for both schemes;
 *   unlinked, a Light theme and a Dark theme picker each set one.
 */
export const AppearanceSheet: Component<{ onClose: () => void }> = (props) => {
	// Font size is localStorage-only (prefs/theme.ts), so this signal mirrors it.
	const [fontSize, setFontSize] = createSignal(currentFontSize());
	// The SDK rows need the model: load it on open (a current one is only revalidated) and keep it current while open.
	onCleanup(holdSettingsModel());
	// Choosing a single-variant theme in the linked picker unlinks, which replaces that picker
	// with two and drops the focus it held: land on the first picker instead of the page.
	let themeRows: HTMLDivElement | undefined;
	createEffect(
		on(
			() => state.themeSelection.linked,
			() =>
				queueMicrotask(() => {
					const active = document.activeElement;
					if (active && active !== document.body) return;
					themeRows?.querySelector<HTMLElement>(".theme-picker-trigger")?.focus();
				}),
			{ defer: true },
		),
	);

	return (
		<Modal variant="sheet" class="appearance-sheet" title="Appearance" onClose={props.onClose}>
			<div class="appearance-sheet-body">
				<SettingsGroup title="Theme & text">
					<SettingsRowLayout label="Mode" compact stacked>
						<ThemeModeControl />
					</SettingsRowLayout>
					<div class="theme-rows" ref={themeRows}>
						<SettingsRowLayout
							label="Theme"
							description="Linked: one theme for light and dark. Unlinked: pick each."
							compact
						>
							<ThemeLinkButton />
						</SettingsRowLayout>
						<Show
							when={state.themeSelection.linked}
							fallback={
								<>
									<SettingsRowLayout label="Light theme" compact stacked>
										<ThemePicker kind="light" label="Light theme" />
									</SettingsRowLayout>
									<SettingsRowLayout label="Dark theme" compact stacked>
										<ThemePicker kind="dark" label="Dark theme" />
									</SettingsRowLayout>
								</>
							}
						>
							<SettingsRowLayout label="Light & dark theme" compact stacked>
								<ThemePicker kind="linked" label="Theme" />
							</SettingsRowLayout>
						</Show>
					</div>
					<ThemeFilesFooter />
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
						description="Collapsed shows header-only cards, Consolidated one row per run of tool calls, Expanded the full cards. Tap a card's hidden-lines button to show all of its output; Ctrl+O on a keyboard shows everything."
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
				<SettingsGroup title="Composer">
					<SettingsRowLayout
						label="Enter Key"
						description="What Enter does in the message box. Auto sends with a mouse and inserts a newline on a touch screen, where the Send button sends. Shift+Enter is always a newline; Ctrl+Enter always sends."
						compact
						stacked
					>
						<SettingSegmented
							label="Enter Key"
							options={ENTER_KEY_CHOICES.map((value) => ({
								value,
								label: value === "newline" ? "New line" : value[0]!.toUpperCase() + value.slice(1),
							}))}
							value={state.display.enterKey}
							onChange={(value) => {
								const choice = ENTER_KEY_CHOICES.find((c) => c === value);
								if (choice) setDisplayPref("enterKey", choice);
							}}
						/>
					</SettingsRowLayout>
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
		</Modal>
	);
};
