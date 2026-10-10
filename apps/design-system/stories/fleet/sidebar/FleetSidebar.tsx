import { FleetSidebar } from "../../../../web/components/fleet/sidebar/FleetSidebar";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-sidebar",
	title: "FleetSidebar",
	component: {
		file: "apps/web/components/fleet/sidebar/FleetSidebar.tsx",
		export: "FleetSidebar",
	},
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Projects and fleet",
			render: () => (
				<div class="ds-frame">
					<FleetSidebar />
				</div>
			),
		},
		{
			name: "Usage panel hidden",
			seed: () => seedRosterFleet({ sidebarUsage: false }),
			render: () => (
				<div class="ds-frame">
					<FleetSidebar />
				</div>
			),
		},
		{
			name: "First run, no projects",
			seed: () => seedRosterFleet({ registeredProjects: [], daemonRoster: [], daemons: new Map() }),
			render: () => (
				<div class="ds-frame">
					<FleetSidebar />
				</div>
			),
		},
	],
});
