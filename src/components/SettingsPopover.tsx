import { createSignal, type Component } from "solid-js";
import { call, setState, state } from "../state";
import {
	currentFontSize,
	currentThemePreference,
	setTheme,
	stepFontSize,
	THEME_OPTIONS,
	type ThemePreference,
} from "../theme";
import { Modal } from "./Modal";

/** Gear popover: queue modes, auto-retry, and the local display toggles. */
export const SettingsPopover: Component<{ onClose: () => void }> = props => {
	const [theme, setThemeSignal] = createSignal<ThemePreference>(currentThemePreference());
	const [fontSize, setFontSize] = createSignal(currentFontSize());

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
					interrupt mode
					<select
						value={state.interruptMode}
						onChange={e => void call("setInterruptMode", [e.currentTarget.value]).catch(err => setState("error", String(err)))}
					>
						<option value="immediate">immediate</option>
						<option value="wait">wait</option>
					</select>
				</label>
				<label class="settings-row">
					auto-retry
					<input
						type="checkbox"
						checked={state.autoRetryEnabled}
						onChange={e => {
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
				<label class="settings-row">
					theme
					<select value={theme()} onChange={e => setThemeSignal(setTheme(e.currentTarget.value as ThemePreference))}>
						{THEME_OPTIONS.map(o => (
							<option value={o.id}>{o.label}</option>
						))}
					</select>
				</label>
				<div class="settings-row">
					font size
					<span>
						<button onClick={() => setFontSize(stepFontSize(-1))}>A−</button>{" "}
						{fontSize()}px{" "}
						<button onClick={() => setFontSize(stepFontSize(1))}>A+</button>
					</span>
				</div>
				<button onClick={() => setState("modal", "login")}>Login providers…</button>
			</div>
		</Modal>
	);
};
