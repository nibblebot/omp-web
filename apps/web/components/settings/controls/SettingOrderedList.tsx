import { For, Show, type Component } from "solid-js";
import { moveSelected, orderedRows, toggleSelected } from "../../../prefs/setting-controls";
import type { SettingsOption } from "#lib/wire/protocol";
import { ArrowDownIcon, ArrowUpIcon } from "../../ui/icons";
import { SettingToggle } from "./SettingToggle";

/**
 * Enabled entries in run order with move up and down, then the disabled ones
 * with only a switch. Order matters for the enabled entries, so only they can move.
 */
export const SettingOrderedList: Component<{
	label: string;
	options: SettingsOption[];
	selected: string[];
	disabled?: boolean;
	onChange: (selected: string[]) => void;
}> = (props) => (
	<ol class="settings-ordered-list" aria-label={props.label}>
		<For each={orderedRows(props.options, props.selected)}>
			{(row) => (
				<li class="settings-ordered-row" classList={{ off: row.rank === undefined }}>
					<span class="settings-ordered-rank">{row.rank === undefined ? "" : row.rank + 1}</span>
					<span class="settings-ordered-name" title={row.option.description}>
						{row.option.label}
					</span>
					<Show when={row.rank !== undefined}>
						<span class="settings-ordered-move">
							<button
								type="button"
								class="settings-stepper-btn"
								aria-label={`Move ${row.option.label} up`}
								disabled={props.disabled || row.rank === 0}
								onClick={() => props.onChange(moveSelected(props.selected, row.option.value, -1))}
							>
								<ArrowUpIcon />
							</button>
							<button
								type="button"
								class="settings-stepper-btn"
								aria-label={`Move ${row.option.label} down`}
								disabled={props.disabled || row.rank === props.selected.length - 1}
								onClick={() => props.onChange(moveSelected(props.selected, row.option.value, 1))}
							>
								<ArrowDownIcon />
							</button>
						</span>
					</Show>
					<SettingToggle
						label={row.option.label}
						checked={row.rank !== undefined}
						disabled={props.disabled}
						onChange={() => props.onChange(toggleSelected(props.selected, row.option.value))}
					/>
				</li>
			)}
		</For>
	</ol>
);
