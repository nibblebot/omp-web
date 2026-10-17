import { Index } from "solid-js";
import { commonSettingGroups } from "../../prefs/settings";
import { state } from "../../state";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow } from "./SettingsRow";
import { WebUiSettings } from "./WebUiSettings";

/**
 * Settings > Common: the daily SDK rows (thinking, tool activity, steering,
 * approvals, notifications), then the browser-local Web UI rows, so the
 * settings people change most often sit on the first tab.
 */
export function CommonSettings() {
	const groups = () => commonSettingGroups(state.settingsModel);
	return (
		<>
			<Index each={groups()}>
				{(group) => (
					<SettingsGroup title={group().title}>
						<Index each={group().items}>{(item) => <SettingsRow item={item()} />}</Index>
					</SettingsGroup>
				)}
			</Index>
			<WebUiSettings />
		</>
	);
}
