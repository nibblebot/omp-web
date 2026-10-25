import { JobsPopover } from "../../../web/components/activities/JobsPopover";
import { seedActivityBar } from "../../fixtures/activity-bar";
import { PopoverAnchor } from "../../fixtures/popover-anchor";
import { defineStory } from "../../registry";

export default defineStory({
	id: "activities-jobs-popover",
	title: "JobsPopover",
	component: { file: "apps/web/components/activities/JobsPopover.tsx", export: "JobsPopover" },
	variants: [
		{
			name: "Running and finished",
			description:
				"One condensed row per job: type icon, label, elapsed time, state. Running jobs come first and their clocks tick. A row opens that job in the Activities panel. While open the popover keeps the shared job poll on its fast cadence.",
			seed: () => seedActivityBar({ jobs: "running" }),
			render: () => <PopoverAnchor label="Jobs" popover={JobsPopover} />,
		},
		{
			name: "More than eight",
			description: 'Eight rows, then "+N more", which opens the panel at the section.',
			seed: () => seedActivityBar({ jobs: "overflow" }),
			render: () => <PopoverAnchor label="Jobs" popover={JobsPopover} />,
		},
	],
});
