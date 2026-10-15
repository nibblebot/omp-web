import { For, type Component } from "solid-js";
import type { SettingsOption } from "#lib/wire/protocol";

/** Two or three short choices shown side by side; the selected one is filled. */
export const SettingSegmented: Component<{
	label: string;
	options: SettingsOption[];
	value: string;
	disabled?: boolean;
	onChange: (value: string) => void;
}> = (props) => (
	<div class="settings-segmented" role="radiogroup" aria-label={props.label}>
		<For each={props.options}>
			{(option) => (
				<button
					type="button"
					role="radio"
					class="settings-segment"
					classList={{ selected: option.value === props.value }}
					aria-checked={option.value === props.value}
					disabled={props.disabled}
					onClick={() => props.onChange(option.value)}
				>
					{option.label}
				</button>
			)}
		</For>
	</div>
);
