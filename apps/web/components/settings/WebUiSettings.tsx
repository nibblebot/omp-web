import { Show } from "solid-js";
import { settingsSectionId } from "../../prefs/settings-tabs";
import { signOut } from "../../store/auth";
import { notificationsBlocked } from "../../store/chat";
import { setNotifyEnabled, state } from "../../state";
import { SettingsRowLayout } from "./SettingsRow";
import { SettingsGroup } from "./SettingsGroup";
import { SettingToggle } from "./controls/SettingToggle";

/**
 * Browser tab of the omp-web section: the Notifications group (the browser's
 * notification permission, a localStorage-backed store toggle) and, while
 * signed in, the Account group. Display preferences (theme, font size, soft
 * fade, sidebar rows and the transcript display settings) live in the
 * header's Appearance popover; session-scoped toggles live on the This Session
 * tab.
 */
export function WebUiSettings() {
	const notifyBlocked = notificationsBlocked();

	return (
		<>
			<SettingsGroup title="Notifications" id={settingsSectionId("web-ui", "Notifications")}>
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
