import { createSignal, type Component } from "solid-js";
import { call, setState, state } from "../state";
import { Modal } from "./Modal";

/** Gear popover: queue modes, auto-retry, and the local display toggles. */
export const SettingsPopover: Component<{ onClose: () => void }> = props => {
	// RpcSessionState does not expose autoRetryEnabled; the toggle is fire-and-forget.
	const [autoRetry, setAutoRetry] = createSignal(true);

	const modeSelect = (label: string, value: () => string, method: "setSteeringMode" | "setFollowUpMode") => (
		<label class="settings-row">
			{label}
			<select value={value()} onChange={e => void call(method, [e.currentTarget.value]).catch(err => setState("error", String(err)))}>
				<option value="all">all</option>
				<option value="one-at-a-time">one-at-a-time</option>
			</select>
		</label>
	);

	return (
		<Modal title="Settings" onClose={props.onClose}>
			<div class="settings-list">
				{modeSelect("steering mode", () => state.steeringMode, "setSteeringMode")}
				{modeSelect("follow-up mode", () => state.followUpMode, "setFollowUpMode")}
				<label class="settings-row">
					auto-retry
					<input
						type="checkbox"
						checked={autoRetry()}
						onChange={e => {
							setAutoRetry(e.currentTarget.checked);
							void call("setAutoRetry", [e.currentTarget.checked]).catch(err => setState("error", String(err)));
						}}
					/>
				</label>
				<label class="settings-row">
					reveal queue
					<input type="checkbox" checked={state.reveal} onChange={e => setState("reveal", e.currentTarget.checked)} />
				</label>
				<label class="settings-row">
					soft fade
					<input type="checkbox" checked={state.soften} onChange={e => setState("soften", e.currentTarget.checked)} />
				</label>
			</div>
		</Modal>
	);
};
