import { RemoveProjectDialog } from "../../../../web/components/fleet/workspaces/RemoveProjectDialog";
import { setState } from "../../../../web/state";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-workspaces-remove-project-dialog",
	title: "RemoveProjectDialog",
	component: {
		file: "apps/web/components/fleet/workspaces/RemoveProjectDialog.tsx",
		export: "RemoveProjectDialog",
	},
	tabs: true,
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Project with running daemons",
			seed: () => seedRosterFleet({ removeProjectTarget: "proj_pi_mono" }),
			render: () => <RemoveProjectDialog />,
		},
		{
			name: "Project with no daemons",
			seed: () => seedRosterFleet({ removeProjectTarget: "proj_docs_site" }),
			render: () => <RemoveProjectDialog />,
		},
		{
			name: "Refused by server",
			seed: () => {
				seedRosterFleet({ removeProjectTarget: "proj_pi_mono" });
				// The refusal frame lands after the dialog opens, as the server sends it.
				setTimeout(
					() => setState("error", "remove refused: 3 daemons still reference pi-mono"),
					400,
				);
			},
			render: () => <RemoveProjectDialog />,
		},
	],
});
