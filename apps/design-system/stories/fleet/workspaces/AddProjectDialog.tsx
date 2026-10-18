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
			name: "Browse repos",
			render: (ctx) => <AddProjectDialog onClose={ctx.close} />,
		},
		{
			name: "Prefilled path",
			seed: () =>
				seedRosterFleet({ modal: "add-project", addProjectPath: "/home/joshua/Repos/omp-web" }),
			render: (ctx) => <AddProjectDialog onClose={ctx.close} />,
		},
		{
			name: "Empty folder",
			seed: () =>
				seedRosterFleet({ modal: "add-project", addProjectPath: "/home/joshua/Repos/empty" }),
			render: (ctx) => <AddProjectDialog onClose={ctx.close} />,
		},
		{
			name: "Unknown path",
			seed: () =>
				seedRosterFleet({ modal: "add-project", addProjectPath: "/home/joshua/Repos/missing" }),
			render: (ctx) => <AddProjectDialog onClose={ctx.close} />,
		},
	],
});
