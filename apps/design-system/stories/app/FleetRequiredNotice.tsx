import { FleetRequiredNotice } from "../../../web/components/app/FleetRequiredNotice";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-fleet-required-notice",
	title: "FleetRequiredNotice",
	component: {
		file: "apps/web/components/app/FleetRequiredNotice.tsx",
		export: "FleetRequiredNotice",
	},
	variants: [
		{
			name: "Bare daemon",
			description:
				"Shown instead of the app shell when the page is served by a bare session daemon.",
			render: () => (
				<div class="ds-frame-tall">
					<FleetRequiredNotice />
				</div>
			),
		},
	],
});
