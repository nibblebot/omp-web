import { SessionDetailsDialog } from "../../../../web/components/fleet/session/SessionDetailsDialog";
import { rosterEntry } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-session-details-dialog",
	title: "SessionDetailsDialog",
	component: {
		file: "apps/web/components/fleet/session/SessionDetailsDialog.tsx",
		export: "SessionDetailsDialog",
	},
	tabs: true,
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Main checkout, ready",
			render: (ctx) => <SessionDetailsDialog session={rosterEntry.main} onClose={ctx.close} />,
		},
		{
			name: "Worktree, attached",
			render: (ctx) => <SessionDetailsDialog session={rosterEntry.worktree} onClose={ctx.close} />,
		},
		{
			name: "Asleep worktree",
			render: (ctx) => <SessionDetailsDialog session={rosterEntry.asleep} onClose={ctx.close} />,
		},
		{
			name: "Clone failed",
			render: (ctx) => (
				<SessionDetailsDialog session={rosterEntry.cloneFailed} onClose={ctx.close} />
			),
		},
		{
			name: "Session error",
			render: (ctx) => (
				<SessionDetailsDialog session={rosterEntry.sessionError} onClose={ctx.close} />
			),
		},
	],
});
