import { DaemonLog } from "../../../../web/components/fleet/daemon/DaemonLog";
import { rosterDaemon } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-daemon-log",
	title: "DaemonLog",
	component: {
		file: "apps/web/components/fleet/daemon/DaemonLog.tsx",
		export: "DaemonLog",
	},
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Attached worktree",
			render: () => <DaemonLog daemonId={rosterDaemon.worktree.daemonId} />,
		},
		{
			name: "Asleep worktree",
			render: () => <DaemonLog daemonId={rosterDaemon.asleep.daemonId} />,
		},
		{
			name: "Clone failed, custom label",
			render: () => (
				<DaemonLog
					daemonId={rosterDaemon.cloneFailed.daemonId}
					label="clone log"
					empty="(clone has not written output yet)"
				/>
			),
		},
		{
			name: "Remote error",
			render: () => <DaemonLog daemonId={rosterDaemon.remoteError.daemonId} />,
		},
	],
});
