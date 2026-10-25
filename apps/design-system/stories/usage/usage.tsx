import { SessionStatsDialog } from "../../../web/components/usage/SessionStatsDialog";
import { UsageLimitsDialog } from "../../../web/components/usage/UsageLimitsDialog";
import { setState } from "../../../web/state";
import { contextBreakdown, sessionStatsSummary } from "../../fixtures/overlays";
import { rosterUsageReports } from "../../fixtures/roster";
import { answerCalls, answerRoutes } from "../../session";
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
		seed: { currentWorkspaceId: "sess_09a41c", autoCompactionEnabled: true },
		variants: [
			{
				name: "Session totals",
				description:
					"Overview tab: key figures and details first. Context and Tools are separate tabs.",
				seed: () =>
					answerCalls({
						getSessionStats: () => sessionStatsSummary,
						getContextBreakdown: () => contextBreakdown,
						getToolSchemas: () => [],
					}),
				render: (ctx) => <SessionStatsDialog onClose={ctx.close} />,
			},
			{
				name: "Auto-compaction off",
				description: "The auto-compaction switch below the actions, in its off position.",
				seed: () => {
					setState("autoCompactionEnabled", false);
					answerCalls({
						getSessionStats: () => sessionStatsSummary,
						getContextBreakdown: () => contextBreakdown,
						getToolSchemas: () => [],
					});
				},
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
						getToolSchemas: () => [],
					}),
				render: (ctx) => <SessionStatsDialog onClose={ctx.close} />,
			},
			{
				name: "Loading",
				seed: () =>
					answerCalls({
						getSessionStats: pending,
						getContextBreakdown: pending,
						getToolSchemas: pending,
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
				seed: () => answerRoutes({ "GET /ctl/usage": () => rosterUsageReports }),
				render: (ctx) => <UsageLimitsDialog onClose={ctx.close} />,
			},
			{
				name: "Loading",
				seed: () => answerRoutes({ "GET /ctl/usage": pending }),
				render: (ctx) => <UsageLimitsDialog onClose={ctx.close} />,
			},
			{
				name: "Fetch failed",
				seed: () =>
					answerRoutes({
						"GET /ctl/usage": () =>
							Response.json({ error: "Usage endpoint returned 503" }, { status: 503 }),
					}),
				render: (ctx) => <UsageLimitsDialog onClose={ctx.close} />,
			},
			{
				name: "No reports",
				seed: () => answerRoutes({ "GET /ctl/usage": () => [] }),
				render: (ctx) => <UsageLimitsDialog onClose={ctx.close} />,
			},
		],
	}),
];
