import { AdvisorPanel } from "../../../web/components/subagents/AdvisorPanel";
import {
	advisorDisabled,
	advisorNoModel,
	advisorOverview,
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
						argRecord(args).section === "stats" ? advisorStats : advisorDisabled,
				}),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AdvisorPanel />
				</div>
			),
		},
		{
			name: "No advisor model",
			description:
				"Enable is withheld: the advisor role has no available model, so the panel links to the Models dialog.",
			seed: () =>
				seedSubagents({
					advisorGetStatus: (args) =>
						argRecord(args).section === "stats" ? advisorStats : advisorNoModel,
				}),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AdvisorPanel />
				</div>
			),
		},
		{
			name: "Config probe warnings",
			seed: () =>
				seedSubagents({
					advisorGetStatus: (args) =>
						argRecord(args).section === "warnings"
							? { warnings: advisorWarnings }
							: advisorOverview,
				}),
			render: () => (
				<div class="ds-frame ds-frame-tall">
					<AdvisorPanel />
				</div>
			),
		},
	],
});
