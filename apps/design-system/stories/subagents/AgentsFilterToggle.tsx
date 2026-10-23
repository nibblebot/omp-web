import { AgentsFilterToggle } from "../../../web/components/subagents/AgentsFilterToggle";
import { setAgentsFilter } from "../../../web/store/dock";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-agents-filter-toggle",
	title: "AgentsFilterToggle",
	component: {
		file: "apps/web/components/subagents/AgentsFilterToggle.tsx",
		export: "AgentsFilterToggle",
	},
	variants: [
		{
			name: "All",
			description:
				"The default: All is pressed and every agent is listed. Each button is a toggle with aria-pressed and calls setAgentsFilter; the labels are words, no icons.",
			render: () => (
				<div class="ds-frame">
					<AgentsFilterToggle />
				</div>
			),
		},
		{
			name: "Running",
			description:
				"Running is pressed and accented: the list keeps running and pending agents, the open agent and the ancestors of those.",
			seed: () => setAgentsFilter("running"),
			render: () => (
				<div class="ds-frame">
					<AgentsFilterToggle />
				</div>
			),
		},
	],
});
