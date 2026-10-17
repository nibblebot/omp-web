import { FirstRunPanel } from "../../../../web/components/fleet/sidebar/FirstRunPanel";
import { seedRosterFleet } from "../../../fixtures/roster-seed";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "fleet-first-run-panel",
	title: "FirstRunPanel",
	component: {
		file: "apps/web/components/fleet/sidebar/FirstRunPanel.tsx",
		export: "FirstRunPanel",
	},
	seed: () => seedRosterFleet({ registeredProjects: [], daemonRoster: [], daemons: new Map() }),
	variants: [
		{
			name: "Fresh fleet",
			render: () => (
				<div class="ds-frame">
					<FirstRunPanel />
				</div>
			),
		},
	],
});
