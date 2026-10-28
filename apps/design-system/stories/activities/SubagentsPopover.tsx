import { SubagentsPopover } from "../../../web/components/activities/SubagentsPopover";
import { addSubagentOverflow, seedActivityBar } from "../../fixtures/activity-bar";
import { PopoverAnchor } from "../../fixtures/popover-anchor";
import { defineStory } from "../../registry";

export default defineStory({
	id: "activities-subagents-popover",
	title: "SubagentsPopover",
	component: {
		file: "apps/web/components/activities/SubagentsPopover.tsx",
		export: "SubagentsPopover",
	},
	variants: [
		{
			name: "Running and finished",
			description:
				"One condensed row per agent: status icon, name, one-line task. A running agent with an estimate adds its stage (secondary text) and a completion ring with its percent; hover for the full estimate. Running agents come first. A row opens that agent in the Activities panel; the popout icon opens the panel at the Subagents section.",
			seed: () => seedActivityBar({ subagents: "running" }),
			render: () => <PopoverAnchor label="Subagents" popover={SubagentsPopover} />,
		},
		{
			name: "More than eight",
			description: 'Eight rows, then "+N more", which opens the panel at the section.',
			seed: () => {
				seedActivityBar({ subagents: "running" });
				addSubagentOverflow();
			},
			render: () => <PopoverAnchor label="Subagents" popover={SubagentsPopover} />,
		},
	],
});
