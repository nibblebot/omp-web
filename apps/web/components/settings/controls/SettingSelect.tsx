import { For, type Component } from "solid-js";
import type { SettingsOption } from "#lib/wire/protocol";
import { ChevronDownIcon } from "../../ui/icons";

/**
 * Native select styled as a pill; keeps the browser's keyboard and screen-reader behaviour.
 * A value absent from `options` is appended, so the control always shows the stored value.
 */
export const SettingSelect: Component<{
	label: string;
	options: SettingsOption[];
	value: string;
	disabled?: boolean;
	onChange: (value: string) => void;
}> = (props) => {
	const options = (): SettingsOption[] =>
		props.options.some((option) => option.value === props.value)
			? props.options
			: [...props.options, { value: props.value, label: props.value }];
	return (
		<span class="settings-select">
			<select
				aria-label={props.label}
				value={props.value}
				disabled={props.disabled}
				onChange={(e) => props.onChange(e.currentTarget.value)}
			>
				<For each={options()}>
					{(option) => <option value={option.value}>{option.label}</option>}
				</For>
			</select>
			<ChevronDownIcon class="settings-select-chevron" />
		</span>
	);
};
