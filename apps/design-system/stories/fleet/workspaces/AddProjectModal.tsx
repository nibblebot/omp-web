import { AddProjectModal } from "../../../../web/components/fleet/workspaces/AddProjectModal";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-workspaces-add-project-modal",
	title: "AddProjectModal",
	component: {
		file: "apps/web/components/fleet/workspaces/AddProjectModal.tsx",
		export: "AddProjectModal",
	},
	tabs: true,
	seed: () => seedRosterFleet({ modal: "add-project" }),
	variants: [
		{
			name: "Register a repo",
			render: () => <AddProjectModal onClose={() => undefined} />,
		},
	],
});
