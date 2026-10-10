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
			render: () => <DaemonDetailsDialog daemon={rosterDaemon.main} onClose={() => undefined} />,
		},
		{
			name: "Worktree, attached",
			render: () => (
				<DaemonDetailsDialog daemon={rosterDaemon.worktree} onClose={() => undefined} />
			),
		},
		{
			name: "Asleep worktree",
			render: () => <DaemonDetailsDialog daemon={rosterDaemon.asleep} onClose={() => undefined} />,
		},
		{
			name: "Clone failed",
			render: () => (
				<DaemonDetailsDialog daemon={rosterDaemon.cloneFailed} onClose={() => undefined} />
			),
		},
		{
			name: "Remote error",
			render: () => (
				<DaemonDetailsDialog daemon={rosterDaemon.remoteError} onClose={() => undefined} />
			),
		},
	],
});
