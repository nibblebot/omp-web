import { onCleanup, onMount, Show } from "solid-js";
import { settingsSectionId } from "../../prefs/settings-tabs";
import { signOut } from "../../store/auth";
import { refreshNotifyPermission } from "../../store/chat";
import { setNotifyEnabled, state } from "../../state";
import { SettingsRowLayout } from "./SettingsRow";
import { SettingsGroup } from "./SettingsGroup";
import { SettingToggle } from "./controls/SettingToggle";

/** Why the notification toggle cannot be turned on, or undefined when it can. */
function notifyWarning(): string | undefined {
	switch (state.notifyPermission) {
		case "denied":
			return "Blocked in this browser. Allow notifications for this site in the browser's site settings to turn this on.";
		case "unsupported":
			return typeof isSecureContext !== "undefined" && !isSecureContext
				? "Browsers only allow notifications over HTTPS or on localhost. Open omp-web at an https:// address to turn this on."
				: "This browser does not support notifications.";
		default:
			return undefined;
	}
}

/**
 * Browser tab of the omp-web section: the Notifications group (the browser's
 * notification permission, a localStorage-backed store toggle) and, while
 * signed in, the Account group. Display preferences (theme, font size, soft
 * fade, sidebar rows and the transcript display settings) live in the
 * header's Appearance popover; session-scoped toggles live on the This Session
 * tab.
 */
export function WebUiSettings() {
	// Permission changes in the browser's site settings, outside the page: re-read it on mount and on refocus.
	onMount(() => {
		refreshNotifyPermission();
		window.addEventListener("focus", refreshNotifyPermission);
		onCleanup(() => window.removeEventListener("focus", refreshNotifyPermission));
	});
	return (
		<>
			<SettingsGroup title="Notifications" id={settingsSectionId("web-ui", "Notifications")}>
				<SettingsRowLayout
					label="Browser Notification Permission"
					description="Grants this browser permission to show OS notifications for sessions other than the one open in this tab. Completion Notification covers finished and aborted turns, Error Notification failed turns, and Ask Notification a session waiting for input. Clicking a notification switches to that session. If none appear, check the system's notification settings and Do Not Disturb."
					warning={notifyWarning()}
				>
					<SettingToggle
						label="Browser Notification Permission"
						checked={state.notifyEnabled && state.notifyPermission === "granted"}
						disabled={notifyWarning() !== undefined}
						onChange={(on) => void setNotifyEnabled(on)}
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
