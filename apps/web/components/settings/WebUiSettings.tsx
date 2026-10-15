import { createSignal, For, Show } from "solid-js";
import { settingsSectionId } from "../../prefs/settings-tabs";
import { authSnapshot, signOut } from "../../store/auth";
import {
	call,
	fleetSettingsActive,
	setNotifyEnabled,
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
 * Web UI tab body: the Interface and Session sections, stacked. Two state
 * sources with intentionally separate update paths (never merged):
 * - client-local (localStorage-backed): theme preference + font size, via
 *   theme.ts; the local signals are seeded from the persisted values. The
 *   usage-in-sidebar visibility toggle is also localStorage-backed
 *   ("omp.sidebarUsage") but flows through the store facade
 *   (state.sidebarUsage / setSidebarUsage), not a local signal;
 * - session-scoped: the soften store toggle and the fast-mode /
 *   auto-retry RPC calls (hidden under the fleet fallback, mirroring their
 *   main-UI session scope).
 * Image handling lives on the Appearance tab (the images.* rows).
 */
export function WebUiSettings() {
	// Client-local theme/font-size (localStorage via theme.ts).
	const [theme, setThemeSignal] = createSignal<ThemePreference>(currentThemePreference());
	const [fontSize, setFontSize] = createSignal(currentFontSize());

	return (
		<>
			<SettingsGroup title="Interface" id={settingsSectionId("web-ui", "Interface")}>
				<SettingsRowLayout label="theme preference">
					<SettingSelect
						label="theme preference"
						options={THEME_OPTIONS.map((o) => ({ value: o.id, label: o.label }))}
						value={theme()}
						onChange={(value) => setThemeSignal(setTheme(value as ThemePreference))}
					/>
				</SettingsRowLayout>
				<SettingsRowLayout label="font size">
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
					label="browser notification permission"
					description="Grants this browser permission to show OS notifications while the tab is hidden. Which events notify is set by Completion, Error and Ask Notification."
				>
					<SettingToggle
						label="browser notification permission"
						checked={state.notifyEnabled}
						onChange={setNotifyEnabled}
					/>
				</SettingsRowLayout>
				<SettingsRowLayout label="soft fade">
					<SettingToggle
						label="soft fade"
						checked={state.soften}
						onChange={(checked) => setState("soften", checked)}
					/>
				</SettingsRowLayout>
				<SettingsRowLayout label="usage in sidebar">
					<SettingToggle
						label="usage in sidebar"
						checked={state.sidebarUsage}
						onChange={setSidebarUsage}
					/>
				</SettingsRowLayout>
				{/* Session-RPC rows: no live session under the fleet fallback, so they
				    would only error. They stay hidden, mirroring their main-UI session
				    scope. */}
				<Show when={!fleetSettingsActive()}>
					<SettingsRowLayout label="fast mode">
						<SettingToggle
							label="fast mode"
							checked={state.fastModeEnabled}
							onChange={(checked) =>
								void call("setFastMode", [checked]).catch((err) => setState("error", String(err)))
							}
						/>
					</SettingsRowLayout>
					<SettingsRowLayout label="auto-retry">
						<SettingToggle
							label="auto-retry"
							checked={state.autoRetryEnabled}
							onChange={(checked) =>
								void call("setAutoRetry", [checked]).catch((err) => setState("error", String(err)))
							}
						/>
					</SettingsRowLayout>
					<SettingsRowLayout label="Login providers…">
						<button
							type="button"
							class="settings-control-btn"
							onClick={() => setState("modal", "login")}
						>
							manage
						</button>
					</SettingsRowLayout>
				</Show>
			</SettingsGroup>
			<Show when={authSnapshot().status === "signedIn"}>
				<SettingsGroup title="Session" id={settingsSectionId("web-ui", "Session")}>
					<SettingsRowLayout label="sign out">
						<button
							type="button"
							class="settings-control-btn"
							onClick={() => {
								void signOut().catch(() => undefined);
							}}
						>
							sign out
						</button>
					</SettingsRowLayout>
				</SettingsGroup>
			</Show>
		</>
	);
}
