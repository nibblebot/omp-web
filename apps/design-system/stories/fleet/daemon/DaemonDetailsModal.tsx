import { DaemonDetailsModal } from "../../../../web/components/fleet/daemon/DaemonDetailsModal";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-daemon-details-modal",
	title: "DaemonDetailsModal",
	component: {
		file: "apps/web/components/fleet/daemon/DaemonDetailsModal.tsx",
		export: "DaemonDetailsModal",
	},
	tabs: true,
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Main checkout, ready",
			render: () => <DaemonDetailsModal daemon={rosterDaemon.main} onClose={() => undefined} />,
		},
		{
			name: "Worktree, attached",
			render: () => <DaemonDetailsModal daemon={rosterDaemon.worktree} onClose={() => undefined} />,
		},
		{
			name: "Asleep worktree",
			render: () => <DaemonDetailsModal daemon={rosterDaemon.asleep} onClose={() => undefined} />,
		},
		{
			name: "Clone failed",
			render: () => (
				<DaemonDetailsModal daemon={rosterDaemon.cloneFailed} onClose={() => undefined} />
			),
		},
		{
			name: "Remote error",
			render: () => (
				<DaemonDetailsModal daemon={rosterDaemon.remoteError} onClose={() => undefined} />
			),
		},
	],
});
