import { AddWorkspaceModal } from "../../../../web/components/fleet/workspaces/AddWorkspaceModal";
import { rememberWorkspaceCreationPrefs } from "../../../../web/prefs/workspace-creation";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-workspaces-add-workspace-modal",
	title: "AddWorkspaceModal",
	component: {
		file: "apps/web/components/fleet/workspaces/AddWorkspaceModal.tsx",
		export: "AddWorkspaceModal",
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
			render: () => <AddWorkspaceModal onClose={() => undefined} />,
		},
		{
			name: "Clone with provider profile",
			seed: () => {
				seedRosterFleet({ workspaceModalProjectId: "proj_omp_web", modal: "workspace" });
				rememberWorkspaceCreationPrefs({ kind: "clone", start: false, profileId: "k8s-bench" });
			},
			render: () => <AddWorkspaceModal onClose={() => undefined} />,
		},
	],
});
