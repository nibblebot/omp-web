import { WorkspaceRow } from "../../../../web/components/fleet/sidebar/WorkspaceRow";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-sidebar-workspace-row",
	title: "WorkspaceRow",
	component: { file: "apps/web/components/fleet/sidebar/WorkspaceRow.tsx", export: "WorkspaceRow" },
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Main checkout, attached",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.main} />
				</div>
			),
		},
		{
			name: "Linked worktree, attached",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.worktree} />
				</div>
			),
		},
		{
			name: "Pre-existing linked worktree",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.registeredWorktree} />
				</div>
			),
		},
		{
			name: "Worktree nested in project group",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.worktree} nested inProjectGroup />
				</div>
			),
		},
		{
			name: "Asleep worktree",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.asleep} />
				</div>
			),
		},
		{
			name: "Starting",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.starting} />
				</div>
			),
		},
		{
			name: "Clone preparing",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.clonePreparing} />
				</div>
			),
		},
		{
			name: "Clone failed",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.cloneFailed} />
				</div>
			),
		},
		{
			name: "Unread output",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.localactionMain} />
				</div>
			),
		},
		{
			name: "Reconnecting",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.reconnecting} />
				</div>
			),
		},
		{
			name: "Remote error",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.remoteError} />
				</div>
			),
		},
		{
			name: "Remote blocked",
			render: () => (
				<div class="sidebar-list">
					<WorkspaceRow daemon={rosterDaemon.remoteBlocked} />
				</div>
			),
		},
	],
});
