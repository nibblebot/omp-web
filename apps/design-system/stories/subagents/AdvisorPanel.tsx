import { AdvisorPanel } from "../../../web/components/subagents/AdvisorPanel";
import {
	advisorDisabled,
	advisorStats,
	advisorWarnings,
	argRecord,
	seedSubagents,
} from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "subagents-advisor-panel",
	title: "AdvisorPanel",
	component: { file: "apps/web/components/subagents/AdvisorPanel.tsx", export: "AdvisorPanel" },
	variants: [
		{
			name: "Two advisors, stats",
			description: "One advisor watching the main session, one already yielded.",
			seed: () => seedSubagents(),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AdvisorPanel />
				</div>
			),
		},
		{
			name: "Advisors disabled",
			seed: () =>
				seedSubagents({
					advisorGetStatus: (args) =>
						argRecord(args).stats === true ? advisorStats : advisorDisabled,
				}),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AdvisorPanel />
				</div>
			),
		},
		{
			name: "Config probe warnings",
			seed: () => seedSubagents({ advisorConfigure: () => advisorWarnings }),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AdvisorPanel />
				</div>
			),
		},
		{
			name: "Daemon predates advisors",
			description: "The daemon does not know advisorGetStatus, so the panel reports the error.",
			seed: () =>
				seedSubagents({
					advisorGetStatus: () => {
						throw new Error("Unknown method advisorGetStatus");
					},
				}),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AdvisorPanel />
				</div>
			),
		},
	],
});
