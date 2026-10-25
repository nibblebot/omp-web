import { DeleteWorkspaceDialog } from "../../../../web/components/fleet/workspaces/DeleteWorkspaceDialog";
import { setState } from "../../../../web/state";
import {
	rosterEntry,
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
					deleteWorkspaceTarget: worktreeInfoClean.workspaceId,
					worktreeDeleteInfo: { [worktreeInfoClean.workspaceId]: worktreeInfoClean },
				}),
			render: () => <DeleteWorkspaceDialog />,
		},
		{
			name: "Dirty linked worktree refused",
			seed: () =>
				seedRosterFleet({
					deleteWorkspaceTarget: worktreeInfoDirty.workspaceId,
					worktreeDeleteInfo: { [worktreeInfoDirty.workspaceId]: worktreeInfoDirty },
				}),
			render: () => <DeleteWorkspaceDialog />,
		},
		{
			name: "Existing branch not pre-checked",
			seed: () =>
				seedRosterFleet({
					deleteWorkspaceTarget: worktreeInfoClean.workspaceId,
					worktreeDeleteInfo: {
						[worktreeInfoClean.workspaceId]: {
							...worktreeInfoClean,
							hasUpstream: false,
						},
					},
				}),
			render: () => <DeleteWorkspaceDialog />,
		},
		{
			name: "Unreadable git state refused",
			seed: () =>
				seedRosterFleet({
					deleteWorkspaceTarget: worktreeInfoClean.workspaceId,
					worktreeDeleteInfo: {
						[worktreeInfoClean.workspaceId]: {
							type: "worktree_delete_info",
							workspaceId: worktreeInfoClean.workspaceId,
							linked: true,
							dirty: false,
							probeFailed: true,
							reason: "worktree git state could not be read; deleting is refused",
						},
					},
				}),
			render: () => <DeleteWorkspaceDialog />,
		},
		{
			name: "Not a linked worktree refused",
			seed: () =>
				seedRosterFleet({
					deleteWorkspaceTarget: worktreeInfoNotLinked.workspaceId,
					worktreeDeleteInfo: { [worktreeInfoNotLinked.workspaceId]: worktreeInfoNotLinked },
				}),
			render: () => <DeleteWorkspaceDialog />,
		},
		{
			name: "Clone delete refused by server",
			seed: () => {
				seedRosterFleet({ deleteWorkspaceTarget: rosterEntry.cloneFailed.workspaceId });
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
