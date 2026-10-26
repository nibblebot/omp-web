import type { JSX } from "solid-js";
import { AllModelsTab } from "../../../web/components/models/AllModelsTab";
import { setState } from "../../../web/state";
import { setModelPickerTask } from "../../../web/store/models";
import { seedDialog } from "../../fixtures/models";
import { sessionModel } from "../../fixtures/overlays";
import { defineStory } from "../../registry";

/** The tab fills the dialog's panel: a frame stands in for the Modal's fixed height and surface. */
const Host = (props: { children: JSX.Element }) => (
	<div class="ds-frame ds-frame-column ds-frame-panel">
		<div class="model-dialog-panel">{props.children}</div>
	</div>
);

const render = () => (
	<Host>
		<AllModelsTab onClose={() => undefined} />
	</Host>
);

export default defineStory({
	id: "models-all-models-tab",
	title: "AllModelsTab",
	component: { file: "apps/web/components/models/AllModelsTab.tsx", export: "AllModelsTab" },
	seed: { currentWorkspaceId: "sess_09a41c", model: sessionModel },
	variants: [
		{
			name: "Session switch",
			description: "Recents first, one locked row, the session model marked current.",
			seed: seedDialog({ tab: "all" }),
			render,
		},
		{
			name: "Task mode",
			description: "The Task toggle is on: picking a row sets the Task subagent model.",
			seed: () => {
				seedDialog({ tab: "all" })();
				setModelPickerTask(true);
				setState("taskModel", "anthropic/claude-haiku-5-5");
			},
			render,
		},
	],
});
