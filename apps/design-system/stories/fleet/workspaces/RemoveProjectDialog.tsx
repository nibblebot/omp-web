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
			name: "Project with running session processes",
			seed: () => seedRosterFleet({ removeProjectTarget: "proj_localaction" }),
			render: () => <RemoveProjectDialog />,
		},
		{
			name: "Project with no session processes",
			seed: () => seedRosterFleet({ removeProjectTarget: "proj_nixos_config" }),
			render: () => <RemoveProjectDialog />,
		},
		{
			name: "Refused by server",
			seed: () => {
				seedRosterFleet({ removeProjectTarget: "proj_localaction" });
				// The refusal frame lands after the dialog opens, as the server sends it.
				setTimeout(
					() =>
						setState("error", "remove refused: 2 session processes still reference localaction"),
					400,
				);
			},
			render: () => <RemoveProjectDialog />,
		},
	],
});
