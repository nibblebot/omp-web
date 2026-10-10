import { SidebarUsage } from "../../../../web/components/fleet/sidebar/SidebarUsage";
import { rosterUsageReports } from "../../../fixtures/roster";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-sidebar-usage",
	title: "SidebarUsage",
	component: { file: "apps/web/components/fleet/sidebar/SidebarUsage.tsx", export: "SidebarUsage" },
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Loaded limits",
			seed: () =>
				seedRosterFleet({
					usageReports: rosterUsageReports,
					usageLoading: false,
					usageError: null,
				}),
			render: () => (
				<div class="ds-frame">
					<SidebarUsage />
				</div>
			),
		},
		{
			name: "Loading",
			seed: () => seedRosterFleet({ usageReports: null, usageLoading: true, usageError: null }),
			render: () => (
				<div class="ds-frame">
					<SidebarUsage />
				</div>
			),
		},
		{
			name: "Failed to load",
			seed: () =>
				seedRosterFleet({
					usageReports: null,
					usageLoading: false,
					usageError: "usage endpoint returned 502",
				}),
			render: () => (
				<div class="ds-frame">
					<SidebarUsage />
				</div>
			),
		},
		{
			name: "No providers reporting",
			seed: () => seedRosterFleet({ usageReports: [], usageLoading: false, usageError: null }),
			render: () => (
				<div class="ds-frame">
					<SidebarUsage />
				</div>
			),
		},
	],
});
