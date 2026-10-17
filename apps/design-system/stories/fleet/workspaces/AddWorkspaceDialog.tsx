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
			// Worktree view: three explicit sources ("New branch", "Existing branch",
			// "Existing folder"), each submitting only its own fields. The Clone tab
			// appears only when provider profiles exist.
			name: "Worktree creation and registration",
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
		{
			// No provider profiles: the Clone tab is hidden and a remembered clone
			// preference falls back to Worktree, with a link to configure providers.
			name: "No provider profiles",
			seed: () => {
				seedRosterFleet({
					workspaceModalProjectId: "proj_omp_web",
					modal: "workspace",
					providerProfiles: [],
				});
				rememberWorkspaceCreationPrefs({ kind: "clone", profileId: "k8s-bench" });
			},
			render: (ctx) => <AddWorkspaceDialog onClose={ctx.close} />,
		},
	],
});
