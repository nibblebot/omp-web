import { autoPending, toggleAutoCompaction } from "../../store/compaction";
import { reportError } from "../../store/toasts";
import { call, setState, state } from "../../state";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRowLayout } from "./SettingsRow";
import { SettingToggle } from "./controls/SettingToggle";

const FAST_MODE_UNSUPPORTED = "Fast mode is not available for the current model.";

/**
 * This Session tab body: toggles that act on the attached session through its
 * RPC methods and nothing else. Each one overrides the saved default until
 * the session process restarts, so the descriptions say so. The sheet renders
 * this tab only while a session is attached (the fleet fallback has no live
 * session, so these calls would only error).
 */
export function SessionSettings() {
	return (
		<SettingsGroup>
			<SettingsRowLayout
				label="Fast Mode"
				description="Priority service tier for this session. Overrides the saved default until the session process restarts."
			>
				<SettingToggle
					label="Fast Mode"
					checked={state.fastModeEnabled}
					onChange={(checked) =>
						void call("setFastMode", [checked])
							.then((supported) => {
								if (supported === false) setState("error", FAST_MODE_UNSUPPORTED);
							})
							.catch(reportError)
					}
				/>
			</SettingsRowLayout>
			<SettingsRowLayout
				label="Auto-Retry"
				description="Retry a failed model request in this session. Overrides the saved default until the session process restarts."
			>
				<SettingToggle
					label="Auto-Retry"
					checked={state.autoRetryEnabled}
					onChange={(checked) => void call("setAutoRetry", [checked]).catch(reportError)}
				/>
			</SettingsRowLayout>
			<SettingsRowLayout
				label="Auto-Compact"
				description="Compact this session automatically when the context fills up. Overrides the saved default until the session process restarts."
			>
				<SettingToggle
					label="Auto-Compact"
					checked={state.autoCompactionEnabled}
					disabled={autoPending()}
					onChange={toggleAutoCompaction}
				/>
			</SettingsRowLayout>
		</SettingsGroup>
	);
}
