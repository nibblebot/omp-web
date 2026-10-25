import { ActivitiesModeToggle } from "../../../web/components/activities/ActivitiesModeToggle";
import { setActivitiesMode } from "../../../web/store/activities";
import { defineStory } from "../../registry";

export default defineStory({
	id: "activities-activities-mode-toggle",
	title: "ActivitiesModeToggle",
	component: {
		file: "apps/web/components/activities/ActivitiesModeToggle.tsx",
		export: "ActivitiesModeToggle",
	},
	variants: [
		{
			name: "Accordion view",
			description:
				"The default: Accordion view is pressed and items expand inline. Each button is a toggle with aria-pressed and calls setActivitiesMode.",
			render: () => (
				<div class="ds-frame">
					<ActivitiesModeToggle />
				</div>
			),
		},
		{
			name: "Detail view",
			description: "Detail view is pressed; the active side is accented.",
			seed: () => setActivitiesMode("detail"),
			render: () => (
				<div class="ds-frame">
					<ActivitiesModeToggle />
				</div>
			),
		},
	],
});
