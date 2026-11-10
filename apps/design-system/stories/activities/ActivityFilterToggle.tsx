import { ActivityFilterToggle } from "../../../web/components/activities/ActivityFilterToggle";
import { setActivityFilter } from "../../../web/store/activities";
import { defineStory } from "../../registry";

export default defineStory({
	id: "activities-activity-filter-toggle",
	title: "ActivityFilterToggle",
	component: {
		file: "apps/web/components/activities/ActivityFilterToggle.tsx",
		export: "ActivityFilterToggle",
	},
	variants: [
		{
			name: "All",
			description:
				"The default: All is pressed and every job is listed. Each button is a toggle with aria-pressed and calls setActivityFilter; the labels are words, no icons.",
			render: () => (
				<div class="ds-frame">
					<ActivityFilterToggle section="jobs" label="Show jobs" />
				</div>
			),
		},
		{
			name: "Running",
			description:
				"Running is pressed and accented: the list keeps running jobs and the expanded ones.",
			seed: () => setActivityFilter("jobs", "running"),
			render: () => (
				<div class="ds-frame">
					<ActivityFilterToggle section="jobs" label="Show jobs" />
				</div>
			),
		},
	],
});
