import { DeleteWorkspaceDialog } from "../../../../web/components/fleet/workspaces/DeleteWorkspaceDialog";
import { setState } from "../../../../web/state";
import {
	rosterDaemon,
	worktreeInfoClean,
	worktreeInfoDirty,
	worktreeInfoNotLinked,
} from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-workspaces-delete-workspace-dialog",
	title: "DeleteWorkspaceDialog",
	component: {
		file: "apps/web/components/fleet/workspaces/DeleteWorkspaceDialog.tsx",
		export: "DeleteWorkspaceDialog",
	},
	tabs: true,
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Clean linked worktree",
			seed: () =>
				seedRosterFleet({
					deleteWorkspaceTarget: worktreeInfoClean.daemonId,
					worktreeDeleteInfo: { [worktreeInfoClean.daemonId]: worktreeInfoClean },
				}),
			render: () => <DeleteWorkspaceDialog />,
		},
		{
			name: "Dirty linked worktree refused",
			seed: () =>
				seedRosterFleet({
					deleteWorkspaceTarget: worktreeInfoDirty.daemonId,
					worktreeDeleteInfo: { [worktreeInfoDirty.daemonId]: worktreeInfoDirty },
				}),
			render: () => <DeleteWorkspaceDialog />,
		},
		{
			name: "Not a linked worktree refused",
			seed: () =>
				seedRosterFleet({
					deleteWorkspaceTarget: worktreeInfoNotLinked.daemonId,
					worktreeDeleteInfo: { [worktreeInfoNotLinked.daemonId]: worktreeInfoNotLinked },
				}),
			render: () => <DeleteWorkspaceDialog />,
		},
		{
			name: "Clone delete refused by server",
			seed: () => {
				seedRosterFleet({ deleteWorkspaceTarget: rosterDaemon.cloneFailed.daemonId });
				// A refusal frame that lands after the dialog opens, as the server sends it.
				setTimeout(
					() => setState("error", "verified delete refused: clone has uncommitted work"),
					400,
				);
			},
			render: () => <DeleteWorkspaceDialog />,
		},
	],
});
