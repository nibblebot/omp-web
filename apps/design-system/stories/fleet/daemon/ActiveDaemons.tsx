import { ActiveDaemons } from "../../../../web/components/fleet/daemon/ActiveDaemons";
import { rosterDaemonMap } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-daemon-active-daemons",
	title: "ActiveDaemons",
	component: {
		file: "apps/web/components/fleet/daemon/ActiveDaemons.tsx",
		export: "ActiveDaemons",
	},
	variants: [
		{
			name: "Supervised processes",
			seed: () => seedRosterFleet({ daemons: rosterDaemonMap(Date.now()) }),
			render: () => (
				<div class="ds-frame">
					<ActiveDaemons />
				</div>
			),
		},
		{
			name: "Single process",
			seed: () =>
				seedRosterFleet({ daemons: new Map([...rosterDaemonMap(Date.now())].slice(0, 1)) }),
			render: () => (
				<div class="ds-frame">
					<ActiveDaemons />
				</div>
			),
		},
	],
});
