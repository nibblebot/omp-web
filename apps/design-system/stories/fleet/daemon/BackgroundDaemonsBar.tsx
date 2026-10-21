import { BackgroundDaemonsBar } from "../../../../web/components/fleet/daemon/BackgroundDaemonsBar";
import { rosterDaemonMap } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-daemon-background-daemons-bar",
	title: "BackgroundDaemonsBar",
	component: {
		file: "apps/web/components/fleet/daemon/BackgroundDaemonsBar.tsx",
		export: "BackgroundDaemonsBar",
	},
	variants: [
		{
			name: "Selected workspace's processes",
			seed: () => seedRosterFleet({ daemons: rosterDaemonMap(Date.now()) }),
			render: () => (
				<div class="ds-frame">
					<BackgroundDaemonsBar />
				</div>
			),
		},
		{
			name: "Single process",
			seed: () =>
				seedRosterFleet({ daemons: new Map([...rosterDaemonMap(Date.now())].slice(0, 1)) }),
			render: () => (
				<div class="ds-frame">
					<BackgroundDaemonsBar />
				</div>
			),
		},
		{
			name: "Another workspace selected",
			seed: () =>
				seedRosterFleet({ currentSessionId: "dmn_b001", daemons: rosterDaemonMap(Date.now()) }),
			render: () => (
				<div class="ds-frame">
					<BackgroundDaemonsBar />
				</div>
			),
		},
	],
});
