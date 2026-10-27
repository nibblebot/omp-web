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
			name: "Browse folders",
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
			name: "Plain folder (no git)",
			description:
				"A folder with no `.git` is addable like any other: no warning, and the Add project button is enabled. The fixture fleet registers it as a plain-directory project.",
			seed: () =>
				seedRosterFleet({
					modal: "add-project",
					addProjectPath: "/home/joshua/Documents/recipes",
				}),
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
