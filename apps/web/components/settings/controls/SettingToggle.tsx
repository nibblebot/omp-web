import type { Component } from "solid-js";

/** On/off switch for boolean settings. A native button, so Space and Enter toggle it from the keyboard. */
export const SettingToggle: Component<{
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}> = (props) => (
	<button
		type="button"
		role="switch"
		class="settings-toggle"
		aria-label={props.label}
		aria-checked={props.checked}
		disabled={props.disabled}
		onClick={() => props.onChange(!props.checked)}
	>
		<span class="settings-toggle-knob" />
	</button>
);
