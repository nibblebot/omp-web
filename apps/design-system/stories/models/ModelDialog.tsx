import { ModelDialog } from "../../../web/components/models/ModelDialog";
import { setState } from "../../../web/state";
import { setModelPickerTask } from "../../../web/store/models";
import { sessionModel } from "../../fixtures/overlays";
import { broken, ciFlag, fast, heavy, seedDialog, shared } from "../../fixtures/models";
import { defineStory } from "../../registry";

export default defineStory({
	id: "models-model-dialog",
	title: "ModelDialog",
	component: { file: "apps/web/components/models/ModelDialog.tsx", export: "ModelDialog" },
	tabs: true,
	seed: {
		currentWorkspaceId: "sess_09a41c",
		model: sessionModel,
	},
	variants: [
		{
			name: "Presets, active",
			description:
				"Five presets: the active one carries an active badge, ci-flag and broken show their layer and a warning marker. The active preset matches the live roles, so no row is marked.",
			seed: seedDialog({
				tab: "presets",
				presets: [heavy, fast, shared, ciFlag, broken],
				active: "heavy",
			}),
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
		{
			name: "Presets, custom roles",
			description:
				"No preset matches the live roles: the first one is selected and rows that differ show 'current: ...'.",
			seed: seedDialog({ tab: "presets", presets: [fast, heavy, shared] }),
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
		{
			name: "Presets, project-sourced",
			description:
				"A preset from the project config is active: Activate is labelled Active, Update and Delete are disabled with the owning layer in their tooltip.",
			seed: seedDialog({ tab: "presets", presets: [heavy, fast, shared], active: "shared" }),
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
		{
			name: "Presets, malformed",
			description:
				"A hand-edited preset that failed to parse: the error replaces the roles, Activate and Update are disabled, Delete stays available.",
			seed: seedDialog({ tab: "presets", presets: [broken, ciFlag, fast] }),
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
		{
			name: "Presets, empty",
			description:
				"Nothing saved yet: an explanation in the detail pane and the Save preset field.",
			seed: seedDialog({ tab: "presets" }),
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
		{
			name: "Roles",
			description:
				"The default role selected: the searchable model list, its model's own thinking levels, Unassign and Hide.",
			seed: seedDialog({ tab: "roles", presets: [heavy] }),
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
		{
			name: "Roles, hidden role",
			description:
				"A hidden, unassigned role: dimmed last in the sidebar, Show instead of Hide, Unassign disabled.",
			seed: seedDialog({ tab: "roles", role: "vision", presets: [heavy] }),
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
		{
			name: "All models",
			description:
				"Session-only switch: recents first, one locked row, the session model marked current.",
			seed: seedDialog({ tab: "all", presets: [heavy] }),
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
		{
			name: "All models, Task mode",
			description: "The Task toggle is on: picking a row sets the Task subagent model.",
			seed: () => {
				seedDialog({ tab: "all", presets: [heavy] })();
				setModelPickerTask(true);
				setState("taskModel", "anthropic/claude-haiku-5-5");
			},
			render: (ctx) => <ModelDialog onClose={ctx.close} />,
		},
	],
});
