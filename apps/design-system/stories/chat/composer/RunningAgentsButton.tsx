import { RunningAgentsButton } from "../../../../web/components/chat/composer/RunningAgentsButton";
import { seedAgentTree } from "../../../fixtures/subagents";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-composer-running-agents-button",
	title: "RunningAgentsButton",
	component: {
		file: "apps/web/components/chat/composer/RunningAgentsButton.tsx",
		export: "RunningAgentsButton",
	},
	variants: [
		{
			name: "No agents running",
			description:
				"Renders nothing at zero running agents. The pending and parked agents in the empty session do not count.",
			seed: () => seedAgentTree({ empty: true }),
			render: () => <RunningAgentsButton />,
		},
		{
			name: "Two running",
			description:
				"Two agents are running, so the button shows the count. Pending and parked agents are not counted.",
			seed: () => seedAgentTree(),
			render: () => <RunningAgentsButton />,
		},
	],
});
