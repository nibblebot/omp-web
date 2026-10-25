import { SessionLog } from "../../../../web/components/fleet/session/SessionLog";
import { rosterEntry } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-session-log",
	title: "SessionLog",
	component: {
		file: "apps/web/components/fleet/session/SessionLog.tsx",
		export: "SessionLog",
	},
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Attached worktree",
			render: () => <SessionLog workspaceId={rosterEntry.worktree.workspaceId} />,
		},
		{
			name: "Asleep worktree",
			render: () => <SessionLog workspaceId={rosterEntry.asleep.workspaceId} />,
		},
		{
			name: "Clone failed, custom label",
			render: () => (
				<SessionLog
					workspaceId={rosterEntry.cloneFailed.workspaceId}
					label="clone log"
					empty="(clone has not written output yet)"
				/>
			),
		},
		{
			name: "Session error",
			render: () => <SessionLog workspaceId={rosterEntry.sessionError.workspaceId} />,
		},
	],
});
