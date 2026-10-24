import { WorktreeSessionsDialog } from "../../../../web/components/fleet/sidebar/WorktreeSessionsDialog";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterSessions } from "../../../fixtures/roster-seed";
import { worktreeSessions, worktreeSessionsMax } from "../../../fixtures/worktree-sessions";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-sidebar-worktree-sessions-dialog",
	title: "WorktreeSessionsDialog",
	component: {
		file: "apps/web/components/fleet/sidebar/WorktreeSessionsDialog.tsx",
		export: "WorktreeSessionsDialog",
	},
	tabs: true,
	variants: [
		{
			name: "Attached worktree",
			description:
				"The worktree the view is on: its live session is marked current and cannot be resumed; the active row shows its first prompt and Resume.",
			seed: () => {
				const sessions = worktreeSessions(Date.now());
				seedRosterSessions(() => sessions, { sessionFile: sessions[0]?.path });
			},
			render: (ctx) => (
				<WorktreeSessionsDialog daemon={rosterDaemon.worktree} onClose={ctx.close} />
			),
		},
		{
			name: "Asleep worktree",
			description: "Listed from disk: resuming a row wakes the worktree on that session.",
			seed: () => seedRosterSessions(() => worktreeSessions(Date.now())),
			render: (ctx) => <WorktreeSessionsDialog daemon={rosterDaemon.asleep} onClose={ctx.close} />,
		},
		{
			name: "Clone",
			description: "A clone titles the dialog with its name, not a branch.",
			seed: () => seedRosterSessions(() => worktreeSessions(Date.now())),
			render: (ctx) => (
				<WorktreeSessionsDialog daemon={rosterDaemon.cloneLocal} onClose={ctx.close} />
			),
		},
		{
			name: "Latest 200",
			description: "The fleet's maximum came back, so the list says it may be cut off.",
			seed: () => seedRosterSessions(() => worktreeSessionsMax(Date.now())),
			render: (ctx) => (
				<WorktreeSessionsDialog daemon={rosterDaemon.worktree} onClose={ctx.close} />
			),
		},
		{
			name: "Loading",
			description: "The list request is still in flight.",
			seed: () => seedRosterSessions(() => null),
			render: (ctx) => (
				<WorktreeSessionsDialog daemon={rosterDaemon.worktree} onClose={ctx.close} />
			),
		},
		{
			name: "No sessions",
			seed: () => seedRosterSessions(() => []),
			render: (ctx) => (
				<WorktreeSessionsDialog daemon={rosterDaemon.worktree} onClose={ctx.close} />
			),
		},
	],
});
