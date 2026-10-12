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
			// One Worktree view: "+ New branch", available branches, checked-out
			// branches that adopt their checkout, and detected unregistered
			// worktrees; every submission starts and attaches a session.
			name: "Worktree creation and adoption",
			seed: () => {
				seedRosterFleet({ workspaceModalProjectId: "proj_omp_web", modal: "workspace" });
				rememberWorkspaceCreationPrefs({ kind: "worktree" });
			},
			render: (ctx) => <AddWorkspaceDialog onClose={ctx.close} />,
		},
		{
			name: "Clone with provider profile",
			seed: () => {
				seedRosterFleet({ workspaceModalProjectId: "proj_omp_web", modal: "workspace" });
				rememberWorkspaceCreationPrefs({ kind: "clone", profileId: "k8s-bench" });
			},
			render: (ctx) => <AddWorkspaceDialog onClose={ctx.close} />,
		},
	],
});
