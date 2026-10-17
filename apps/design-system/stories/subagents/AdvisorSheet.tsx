import { AdvisorSheet } from "../../../web/components/subagents/AdvisorSheet";
import { seedSubagents } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-advisor-sheet",
	title: "AdvisorSheet",
	component: {
		file: "apps/web/components/subagents/AdvisorSheet.tsx",
		export: "AdvisorSheet",
	},
	tabs: true,
	variants: [
		{
			name: "Sheet open",
			description: "The advisor panel in a sheet over the session, with two advisors.",
			seed: () => seedSubagents(),
			render: (ctx) => <AdvisorSheet onClose={ctx.close} />,
		},
	],
});
