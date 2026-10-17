import { SessionStatsDialog } from "../../../web/components/usage/SessionStatsDialog";
import { UsageLimitsDialog } from "../../../web/components/usage/UsageLimitsDialog";
import { contextBreakdown, sessionStatsSummary } from "../../fixtures/overlays";
import { rosterUsageReports } from "../../fixtures/roster";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

const pending = () => Promise.withResolvers<unknown>().promise;

export default [
	defineStory({
		id: "usage-session-stats-dialog",
		title: "SessionStatsDialog",
		component: {
			file: "apps/web/components/usage/SessionStatsDialog.tsx",
			export: "SessionStatsDialog",
		},
		tabs: true,
		seed: { currentSessionId: "sess_09a41c", autoCompactionEnabled: true },
		variants: [
			{
				name: "Session totals",
				description:
					"Overview tab: key figures and details first. Context and Tools are separate tabs.",
				seed: () =>
					answerCalls({
						getSessionStats: () => sessionStatsSummary,
						getContextBreakdown: () => contextBreakdown,
					}),
				render: (ctx) => <SessionStatsDialog onClose={ctx.close} />,
			},
			{
				name: "Breakdown unavailable",
				description:
					"Totals load; the context breakdown call fails. The Context tab shows a fallback note.",
				seed: () =>
					answerCalls({
						getSessionStats: () => sessionStatsSummary,
						getContextBreakdown: () => {
							throw new Error("context breakdown unavailable");
						},
					}),
				render: (ctx) => <SessionStatsDialog onClose={ctx.close} />,
			},
			{
				name: "Loading",
				seed: () =>
					answerCalls({
						getSessionStats: pending,
						getContextBreakdown: pending,
					}),
				render: (ctx) => <SessionStatsDialog onClose={ctx.close} />,
			},
		],
	}),
	defineStory({
		id: "usage-limits-dialog",
		title: "UsageLimitsDialog",
		component: {
			file: "apps/web/components/usage/UsageLimitsDialog.tsx",
			export: "UsageLimitsDialog",
		},
		tabs: true,
		variants: [
			{
				name: "Provider windows",
				description: "Rate-limit windows per provider with reset times.",
				seed: () =>
					answerCalls({
						fetchUsageReports: () => rosterUsageReports,
					}),
				render: (ctx) => <UsageLimitsDialog onClose={ctx.close} />,
			},
			{
				name: "Loading",
				seed: () => answerCalls({ fetchUsageReports: pending }),
				render: (ctx) => <UsageLimitsDialog onClose={ctx.close} />,
			},
			{
				name: "Fetch failed",
				seed: () =>
					answerCalls({
						fetchUsageReports: () => {
							throw new Error("Usage endpoint returned 503");
						},
					}),
				render: (ctx) => <UsageLimitsDialog onClose={ctx.close} />,
			},
			{
				name: "No reports",
				seed: () => answerCalls({ fetchUsageReports: () => [] }),
				render: (ctx) => <UsageLimitsDialog onClose={ctx.close} />,
			},
		],
	}),
];
