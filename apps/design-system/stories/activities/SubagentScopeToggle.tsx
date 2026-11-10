import { SubagentScopeToggle } from "../../../web/components/activities/SubagentScopeToggle";
import { setActivityFilter } from "../../../web/store/activities";
import { seedAgentTree } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

const toggle = () => (
	<div class="ds-frame">
		<SubagentScopeToggle />
	</div>
);

export default defineStory({
	id: "activities-subagent-scope-toggle",
	title: "SubagentScopeToggle",
	component: {
		file: "apps/web/components/activities/SubagentScopeToggle.tsx",
		export: "SubagentScopeToggle",
	},
	variants: [
		{
			name: "All, mixed statuses",
			description:
				"The default: All is pressed. Counts come from the shared forest: All counts every agent (the aborted one too), Running counts running and pending, Done counts finished and failed, Parked the parked one. Each button is a toggle with aria-pressed that calls setActivityFilter.",
			seed: () => seedAgentTree({ display: true }),
			render: toggle,
		},
		{
			name: "Done pressed",
			description: "Done is pressed and accented, its count in the accent color too.",
			seed: () => {
				seedAgentTree({ display: true });
				setActivityFilter("subagents", "done");
			},
			render: toggle,
		},
		{
			name: "Empty scope",
			description:
				"Everything settled: Running shows 0 and stays selectable, as in the agent hub, so a persisted Running choice can always be switched back.",
			seed: () => {
				seedAgentTree({ display: true, settled: true });
				setActivityFilter("subagents", "running");
			},
			render: toggle,
		},
	],
});
