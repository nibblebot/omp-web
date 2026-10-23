import { AgentsModeToggle } from "../../../web/components/subagents/AgentsModeToggle";
import { setAgentsMode } from "../../../web/store/dock";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-agents-mode-toggle",
	title: "AgentsModeToggle",
	component: {
		file: "apps/web/components/subagents/AgentsModeToggle.tsx",
		export: "AgentsModeToggle",
	},
	variants: [
		{
			name: "Single agent view",
			description:
				"The default: Single agent view is pressed. Each button is a toggle with aria-pressed and calls setAgentsMode.",
			render: () => (
				<div class="ds-frame">
					<AgentsModeToggle />
				</div>
			),
		},
		{
			name: "Accordion view",
			description: "Accordion view is pressed; the active side is accented.",
			seed: () => setAgentsMode("accordion"),
			render: () => (
				<div class="ds-frame">
					<AgentsModeToggle />
				</div>
			),
		},
	],
});
