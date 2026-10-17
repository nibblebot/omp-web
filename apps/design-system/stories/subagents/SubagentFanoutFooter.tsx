import { SubagentFanoutFooter } from "../../../web/components/subagents/SubagentFanoutFooter";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-fanout-footer",
	title: "SubagentFanoutFooter",
	component: {
		file: "apps/web/components/subagents/SubagentFanoutFooter.tsx",
		export: "SubagentFanoutFooter",
	},
	variants: [
		{
			name: "With failures",
			description: "Totals across the fan-out; the failed count appears beside the running count.",
			render: () => (
				<SubagentFanoutFooter
					totals={{
						count: 6,
						running: 2,
						failed: 1,
						tokens: 92_000,
						cost: 0.607,
						elapsedMs: 548_000,
					}}
				/>
			),
		},
		{
			name: "No failures",
			description: "Totals with no failed agents; the failed count is omitted.",
			render: () => (
				<SubagentFanoutFooter
					totals={{
						count: 3,
						running: 1,
						failed: 0,
						tokens: 24_300,
						cost: 0.118,
						elapsedMs: 150_000,
					}}
				/>
			),
		},
	],
});
