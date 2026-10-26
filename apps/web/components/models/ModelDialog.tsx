import { createEffect, createSignal, Match, on, Switch, type Component } from "solid-js";
import { state, type ModelDialogTab } from "../../state";
import { loadModelPresets, selectModelDialogTab } from "../../store/models";
import { Modal } from "../ui/Modal";
import { Tabs, tabButtonId, tabPanelId } from "../ui/Tabs";
import { AllModelsTab } from "./AllModelsTab";
import { ModelPresetsTab } from "./ModelPresetsTab";
import { ModelRolesTab } from "./ModelRolesTab";
import type { ModelDialogPane } from "../../usage/model-roles";
import "./models.css";

const TABS: ReadonlyArray<{ id: ModelDialogTab; label: string }> = [
	{ id: "presets", label: "Presets" },
	{ id: "roles", label: "Roles" },
	{ id: "all", label: "All models" },
];

const ID_PREFIX = "model-dialog";

/**
 * The Models dialog: saved presets, role assignments, and the full model list, one
 * tab each. Presets and Roles are a sidebar plus a detail pane; below 768px the
 * sidebar fills the dialog and choosing an item drills into its detail with a Back
 * button. Every entry point opens it through `openModelDialog`, which picks the tab.
 */
export const ModelDialog: Component<{ onClose: () => void }> = (props) => {
	// A role named by the entry point (status bar, Settings) opens straight on its detail when narrow.
	const [pane, setPane] = createSignal<ModelDialogPane>(
		state.modelDialogTab === "roles" && state.modelDialogRole !== undefined ? "detail" : "list",
	);

	// The server announces preset changes (a save or delete from another client, /model-preset) through the state frame.
	createEffect(
		on(
			() => [state.modelPresets?.names.join("\n"), state.modelPresets?.active],
			() => void loadModelPresets(),
			{ defer: true },
		),
	);

	return (
		<Modal title="Models" class="model-dialog" size="wide" onClose={props.onClose}>
			<Tabs
				tabs={TABS}
				value={state.modelDialogTab}
				label="Models"
				idPrefix={ID_PREFIX}
				onChange={(tab) => {
					selectModelDialogTab(tab);
					setPane("list");
				}}
			/>
			<div
				class="model-dialog-panel"
				role="tabpanel"
				id={tabPanelId(ID_PREFIX, state.modelDialogTab)}
				aria-labelledby={tabButtonId(ID_PREFIX, state.modelDialogTab)}
			>
				<Switch>
					<Match when={state.modelDialogTab === "presets"}>
						<ModelPresetsTab pane={pane()} onPane={setPane} onClose={props.onClose} />
					</Match>
					<Match when={state.modelDialogTab === "roles"}>
						<ModelRolesTab pane={pane()} onPane={setPane} />
					</Match>
					<Match when={state.modelDialogTab === "all"}>
						<AllModelsTab onClose={props.onClose} />
					</Match>
				</Switch>
			</div>
		</Modal>
	);
};
