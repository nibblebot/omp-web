import { AddWorkspaceDialog } from "../../../../web/components/fleet/workspaces/AddWorkspaceDialog";
import { rememberWorkspaceCreationPrefs } from "../../../../web/prefs/workspace-creation";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-workspaces-add-workspace-dialog",
	title: "AddWorkspaceDialog",
	component: {
		file: "apps/web/components/fleet/workspaces/AddWorkspaceDialog.tsx",
		export: "AddWorkspaceDialog",
	},
	tabs: true,
	seed: () => seedRosterFleet({ workspaceModalProjectId: "proj_omp_web", modal: "workspace" }),
	variants: [
		{
			name: "New worktree",
			seed: () => {
				seedRosterFleet({ workspaceModalProjectId: "proj_omp_web", modal: "workspace" });
				rememberWorkspaceCreationPrefs({ kind: "worktree", start: true });
			},
			render: () => <AddWorkspaceDialog onClose={() => undefined} />,
		},
		{
			name: "Clone with provider profile",
			seed: () => {
				seedRosterFleet({ workspaceModalProjectId: "proj_omp_web", modal: "workspace" });
				rememberWorkspaceCreationPrefs({ kind: "clone", start: false, profileId: "k8s-bench" });
			},
			render: () => <AddWorkspaceDialog onClose={() => undefined} />,
		},
	],
});
