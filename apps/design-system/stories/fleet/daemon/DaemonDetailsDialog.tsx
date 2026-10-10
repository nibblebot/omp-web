import { DaemonDetailsDialog } from "../../../../web/components/fleet/daemon/DaemonDetailsDialog";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-daemon-details-dialog",
	title: "DaemonDetailsDialog",
	component: {
		file: "apps/web/components/fleet/daemon/DaemonDetailsDialog.tsx",
		export: "DaemonDetailsDialog",
	},
	tabs: true,
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Main checkout, ready",
			render: (ctx) => <DaemonDetailsDialog daemon={rosterDaemon.main} onClose={ctx.close} />,
		},
		{
			name: "Worktree, attached",
			render: (ctx) => <DaemonDetailsDialog daemon={rosterDaemon.worktree} onClose={ctx.close} />,
		},
		{
			name: "Asleep worktree",
			render: (ctx) => <DaemonDetailsDialog daemon={rosterDaemon.asleep} onClose={ctx.close} />,
		},
		{
			name: "Clone failed",
			render: (ctx) => (
				<DaemonDetailsDialog daemon={rosterDaemon.cloneFailed} onClose={ctx.close} />
			),
		},
		{
			name: "Remote error",
			render: (ctx) => (
				<DaemonDetailsDialog daemon={rosterDaemon.remoteError} onClose={ctx.close} />
			),
		},
	],
});
