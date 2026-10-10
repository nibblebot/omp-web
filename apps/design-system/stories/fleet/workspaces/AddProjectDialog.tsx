import { AddProjectDialog } from "../../../../web/components/fleet/workspaces/AddProjectDialog";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-workspaces-add-project-dialog",
	title: "AddProjectDialog",
	component: {
		file: "apps/web/components/fleet/workspaces/AddProjectDialog.tsx",
		export: "AddProjectDialog",
	},
	tabs: true,
	seed: () => seedRosterFleet({ modal: "add-project" }),
	variants: [
		{
			name: "Register a repo",
			render: () => <AddProjectDialog onClose={() => undefined} />,
		},
	],
});
