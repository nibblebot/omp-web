import { SubagentFanoutTotals } from "../../../web/components/subagents/SubagentFanoutTotals";
import type { SubagentTotals } from "../../../web/subagents/tree";
import { defineStory } from "../../registry";

const withFailures: SubagentTotals = {
	count: 6,
	running: 2,
	failed: 1,
	tokens: 92_000,
	cost: 0.607,
	elapsedMs: 548_000,
};

const noFailures: SubagentTotals = {
	count: 3,
	running: 1,
	failed: 0,
	tokens: 24_300,
	cost: 0.118,
	elapsedMs: 150_000,
};

export default defineStory({
	id: "subagents-fanout-totals",
	title: "SubagentFanoutTotals",
	component: {
		file: "apps/web/components/subagents/SubagentFanoutTotals.tsx",
		export: "SubagentFanoutTotals",
	},
	variants: [
		{
			name: "Footer, with failures",
			description:
				"The agents panel's bottom strip: totals across the forest; the failed count appears beside the running count.",
			render: () => <SubagentFanoutTotals totals={withFailures} placement="footer" />,
		},
		{
			name: "Footer, no failures",
			description: "Totals with no failed agents; the failed count is omitted.",
			render: () => <SubagentFanoutTotals totals={noFailures} placement="footer" />,
		},
		{
			name: "Header",
			description:
				"Inline in the task card header, pushed to the right edge; see TaskToolCard for it in place.",
			render: () => <SubagentFanoutTotals totals={withFailures} placement="header" />,
		},
	],
});
