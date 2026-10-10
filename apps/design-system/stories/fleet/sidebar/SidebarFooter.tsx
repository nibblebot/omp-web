import { SidebarFooter } from "../../../../web/components/fleet/sidebar/SidebarFooter";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-sidebar-footer",
	title: "SidebarFooter",
	component: {
		file: "apps/web/components/fleet/sidebar/SidebarFooter.tsx",
		export: "SidebarFooter",
	},
	seed: () => seedRosterFleet(),
	variants: [
		{
			name: "Idle",
			render: () => (
				<div class="ds-frame">
					<aside class="sidebar open">
						<SidebarFooter />
					</aside>
				</div>
			),
		},
		{
			name: "Debug panel active",
			seed: () => seedRosterFleet({ modal: "debug" }),
			render: () => (
				<div class="ds-frame">
					<aside class="sidebar open">
						<SidebarFooter />
					</aside>
				</div>
			),
		},
	],
});
