import { onMount, Show, type Component } from "solid-js";
import { state } from "../../state";
import {
	clearTaskModel,
	closeModelPicker,
	loadModelBrowser,
	openModelPicker,
	pickTaskModel,
	switchSessionModel,
} from "../../store/models";
import { Modal } from "../ui/Modal";
import { ModelSearchList } from "./ModelSearchList";

/** Quick model picker (Alt+P). Session-only switch, or the Task-model override when opened in Task mode. */
export const ModelPicker: Component<{ onClose: () => void }> = (props) => {
	const currentSelector = (): string | undefined =>
		state.model ? `${state.model.provider}/${state.model.id}` : undefined;
	const pick = (selector: string): Promise<boolean> =>
		state.modelPickerTask ? pickTaskModel(selector) : switchSessionModel(selector);

	onMount(() => {
		void loadModelBrowser();
	});

	return (
		<Modal title="Model" onClose={props.onClose}>
			<div class="model-picker">
				<p class="picker-detail">
					Session-only. Roles unchanged. Set as default in Settings &gt; Model.
				</p>
				<div class="model-picker-task">
					<button
						type="button"
						class="picker-row-action"
						aria-pressed={!!state.modelPickerTask}
						title="Pick the model used by Task subagents"
						onClick={() => openModelPicker(!state.modelPickerTask)}
					>
						Task model: {state.taskModel ?? "inherits session model"}
					</button>
					<Show when={state.taskModel}>
						<button type="button" class="picker-row-action" onClick={() => void clearTaskModel()}>
							Clear
						</button>
					</Show>
				</div>
				<ModelSearchList
					label="Search models"
					placeholder={state.modelPickerTask ? "Search models for Task" : "Search models"}
					currentSelector={currentSelector()}
					onPick={pick}
					onPicked={closeModelPicker}
				/>
			</div>
		</Modal>
	);
};
