import { createSignal, Show } from "solid-js";
import { settingsSectionId } from "../../prefs/settings-tabs";
import { signOut } from "../../store/auth";
import { notificationsBlocked } from "../../store/chat";
import {
	setNotifyEnabled,
	setSidebarSessionTitleLines,
	setSidebarTitleFirst,
	setSidebarUsage,
	setState,
	state,
} from "../../state";
import { MinusIcon, PlusIcon } from "../ui/icons";
import {
	currentFontSize,
	currentThemePreference,
	setTheme,
	stepFontSize,
	THEME_OPTIONS,
	type ThemePreference,
} from "../../prefs/theme";
import { SettingsRowLayout } from "./SettingsRow";
import { SettingsGroup } from "./SettingsGroup";
import { SettingSelect } from "./controls/SettingSelect";
import { SettingToggle } from "./controls/SettingToggle";

/**
 * Appearance tab of the omp-web section: the Interface group (browser-local
 * preferences) and, while signed in, the Account group. Interface state is
 * client-local (localStorage-backed): theme preference and font size via
 * theme.ts, whose local signals are seeded from the persisted values; the
 * notification, soft-fade and usage-in-sidebar toggles flow through the store
 * facade. Session-scoped toggles live on the This Session tab; image handling
 * lives on the Display tab (the images.* rows).
 */
export function WebUiSettings() {
	// Client-local theme/font-size (localStorage via theme.ts).
	const [theme, setThemeSignal] = createSignal<ThemePreference>(currentThemePreference());
	const [fontSize, setFontSize] = createSignal(currentFontSize());
	const notifyBlocked = notificationsBlocked();

	return (
		<>
			<SettingsGroup title="Interface" id={settingsSectionId("web-ui", "Interface")}>
				<SettingsRowLayout label="Theme">
					<SettingSelect
						label="Theme"
						options={THEME_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
						value={theme()}
						onChange={(value) => setThemeSignal(setTheme(value as ThemePreference))}
					/>
				</SettingsRowLayout>
				<SettingsRowLayout label="Font Size">
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
				{/* Client-local store toggles (setNotifyEnabled persists to
				    localStorage as well; soften is a UI pref). */}
				<SettingsRowLayout
					label="Browser Notification Permission"
					description="Grants this browser permission to show OS notifications while the tab is hidden. Which events notify is set by Completion, Error and Ask Notification."
					warning={
						notifyBlocked
							? "Blocked in this browser. Allow notifications for this site in the browser's site settings to turn this on."
							: undefined
					}
				>
					<SettingToggle
						label="Browser Notification Permission"
						checked={state.notifyEnabled && !notifyBlocked}
						disabled={notifyBlocked}
						onChange={setNotifyEnabled}
					/>
				</SettingsRowLayout>
				<SettingsRowLayout label="Soft Fade">
					<SettingToggle
						label="Soft Fade"
						checked={state.soften}
						onChange={(checked) => setState("soften", checked)}
					/>
				</SettingsRowLayout>
				<SettingsRowLayout label="Usage in Sidebar">
					<SettingToggle
						label="Usage in Sidebar"
						checked={state.sidebarUsage}
						onChange={setSidebarUsage}
					/>
				</SettingsRowLayout>
				<SettingsRowLayout
					label="Two-Line Session Titles"
					description="Lets a roster row show up to two lines of its last session title instead of one. A short title still takes one line."
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
				>
					<SettingToggle
						label="Title-First Workspace Rows"
						checked={state.sidebarTitleFirst}
						onChange={setSidebarTitleFirst}
					/>
				</SettingsRowLayout>
			</SettingsGroup>
			<Show when={state.authStatus === "signedIn"}>
				<SettingsGroup title="Account" id={settingsSectionId("web-ui", "Account")}>
					<SettingsRowLayout label="Sign Out">
						<button
							type="button"
							class="settings-control-btn"
							onClick={() => {
								void signOut().catch(() => undefined);
							}}
						>
							Sign Out
						</button>
					</SettingsRowLayout>
				</SettingsGroup>
			</Show>
		</>
	);
}
