import { Show, type Component } from "solid-js";
import { ModelSearchList } from "../models/ModelSearchList";
import { ChevronDownIcon } from "../ui/icons";

/**
 * A role's model: a button showing the assigned model that opens the composer's
 * searchable model list inline, with "Clear (inherit)". The parent owns `open`
 * and closes the list after a pick or clear is applied.
 */
export const RoleModelPicker: Component<{
	role: string;
	name: string;
	selector?: string;
	open: boolean;
	disabled: boolean;
	onOpen: () => void;
	onClose: () => void;
	onPick: (selector: string) => Promise<boolean>;
	onClear: () => Promise<boolean>;
}> = (props) => {
	const clear = async (): Promise<void> => {
		if (await props.onClear()) props.onClose();
	};

	return (
		<>
			<button
				type="button"
				class="settings-roles-model"
				aria-label={`Model for role ${props.name}`}
				aria-expanded={props.open}
				aria-controls={`role-models-${props.role}`}
				disabled={props.disabled}
				onClick={() => (props.open ? props.onClose() : props.onOpen())}
			>
				<span class="settings-roles-value">{props.selector ?? "inherits default"}</span>
				<ChevronDownIcon class="settings-select-chevron" />
			</button>
			<Show when={props.open}>
				<div class="settings-role-picker" id={`role-models-${props.role}`}>
					<button
						type="button"
						class="picker-row-action"
						disabled={props.disabled}
						onClick={() => void clear()}
					>
						Clear (inherit)
					</button>
					<ModelSearchList
						label={`Search models for role ${props.name}`}
						placeholder="Search models"
						currentSelector={props.selector}
						onPick={props.onPick}
						onPicked={props.onClose}
						onEscape={props.onClose}
					/>
				</div>
			</Show>
		</>
	);
};
