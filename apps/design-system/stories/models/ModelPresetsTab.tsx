import type { JSX } from "solid-js";
import { ModelPresetsTab } from "../../../web/components/models/ModelPresetsTab";
import { broken, ciFlag, fast, heavy, seedDialog, shared } from "../../fixtures/models";
import { defineStory } from "../../registry";

/** The tab fills the dialog's panel: a frame stands in for the Modal's fixed height and surface. */
const Host = (props: { children: JSX.Element }) => (
	<div class="ds-frame ds-frame-column ds-frame-panel">
		<div class="model-dialog-panel">{props.children}</div>
	</div>
);

const render = () => (
	<Host>
		<ModelPresetsTab pane="list" onPane={() => undefined} onClose={() => undefined} />
	</Host>
);

export default defineStory({
	id: "models-model-presets-tab",
	title: "ModelPresetsTab",
	component: {
		file: "apps/web/components/models/ModelPresetsTab.tsx",
		export: "ModelPresetsTab",
	},
	seed: { currentWorkspaceId: "sess_09a41c" },
	variants: [
		{
			name: "Active preset",
			description: "The active preset selected: no row differs from the live roles.",
			seed: seedDialog({
				tab: "presets",
				presets: [heavy, fast, shared, ciFlag, broken],
				active: "heavy",
			}),
			render,
		},
		{
			name: "Differs from current roles",
			description:
				"No active preset: the first one is selected and rows that differ show the current model.",
			seed: seedDialog({ tab: "presets", presets: [fast, heavy, shared] }),
			render,
		},
		{
			name: "Malformed preset",
			description: "The parse error replaces the roles; Activate and Update are disabled.",
			seed: seedDialog({ tab: "presets", presets: [broken, ciFlag, fast] }),
			render,
		},
		{
			name: "No presets",
			seed: seedDialog({ tab: "presets" }),
			render,
		},
	],
});
