import { Show, type Component } from "solid-js";
import { state } from "../../state";
import {
	clearTaskModel,
	pickTaskModel,
	setModelPickerTask,
	switchSessionModel,
} from "../../store/models";
import { ModelSearchList } from "./ModelSearchList";

/**
 * All models tab: the searchable list of chat models. A pick switches this session
 * only (roles unchanged), or sets the Task subagent model while the Task toggle is on.
 */
export const AllModelsTab: Component<{ onClose: () => void }> = (props) => {
	const currentSelector = (): string | undefined =>
		state.model ? `${state.model.provider}/${state.model.id}` : undefined;
	const pick = (selector: string): Promise<boolean> =>
		state.modelPickerTask ? pickTaskModel(selector) : switchSessionModel(selector);

	return (
		<div class="model-dialog-all">
			<p class="picker-detail">
				Session-only. Roles unchanged. Assign models to roles in the Roles tab.
			</p>
			<div class="model-picker-task">
				<button
					type="button"
					class="picker-row-action"
					aria-pressed={state.modelPickerTask}
					title="Pick the model used by Task subagents"
					onClick={() => setModelPickerTask(!state.modelPickerTask)}
				>
					Task model: {state.taskModel ?? "inherits session model"}
				</button>
				<Show when={state.taskModel}>
					<button type="button" class="picker-row-action" onClick={() => void clearTaskModel()}>
						Clear
					</button>
				</Show>
			</div>
			<div class="model-dialog-grow">
				<ModelSearchList
					label="Search models"
					placeholder={state.modelPickerTask ? "Search models for Task" : "Search models"}
					currentSelector={currentSelector()}
					kinds={["chat"]}
					onPick={pick}
					onPicked={props.onClose}
				/>
			</div>
		</div>
	);
};
