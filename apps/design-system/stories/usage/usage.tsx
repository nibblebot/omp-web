import { SessionStatsModal } from "../../../web/components/usage/SessionStatsModal";
import { UsageLimitsModal } from "../../../web/components/usage/UsageLimitsModal";
import { contextBreakdown, sessionStatsSummary } from "../../fixtures/overlays";
import { rosterUsageReports } from "../../fixtures/roster";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

const pending = () => Promise.withResolvers<unknown>().promise;

export default [
	defineStory({
		id: "usage-session-stats-modal",
		title: "SessionStatsModal",
		component: {
			file: "apps/web/components/usage/SessionStatsModal.tsx",
			export: "SessionStatsModal",
		},
		tabs: true,
		seed: { currentSessionId: "sess_09a41c", autoCompactionEnabled: true },
		variants: [
			{
				name: "Session totals",
				description: "Token usage, cost, and the per-category context breakdown.",
				seed: () =>
					answerCalls({
						getSessionStats: () => sessionStatsSummary,
						getContextBreakdown: () => contextBreakdown,
					}),
				render: () => <SessionStatsModal onClose={() => undefined} />,
			},
			{
				name: "Breakdown unavailable",
				description: "Totals load; the context breakdown call fails and is omitted.",
				seed: () =>
					answerCalls({
						getSessionStats: () => sessionStatsSummary,
						getContextBreakdown: () => {
							throw new Error("context breakdown unavailable");
						},
					}),
				render: () => <SessionStatsModal onClose={() => undefined} />,
			},
			{
				name: "Loading",
				seed: () =>
					answerCalls({
						getSessionStats: pending,
						getContextBreakdown: pending,
					}),
				render: () => <SessionStatsModal onClose={() => undefined} />,
			},
		],
	}),
	defineStory({
		id: "usage-limits-modal",
		title: "UsageLimitsModal",
		component: {
			file: "apps/web/components/usage/UsageLimitsModal.tsx",
			export: "UsageLimitsModal",
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
				render: () => <UsageLimitsModal onClose={() => undefined} />,
			},
			{
				name: "Loading",
				seed: () => answerCalls({ fetchUsageReports: pending }),
				render: () => <UsageLimitsModal onClose={() => undefined} />,
			},
			{
				name: "Fetch failed",
				seed: () =>
					answerCalls({
						fetchUsageReports: () => {
							throw new Error("Usage endpoint returned 503");
						},
					}),
				render: () => <UsageLimitsModal onClose={() => undefined} />,
			},
			{
				name: "No reports",
				seed: () => answerCalls({ fetchUsageReports: () => [] }),
				render: () => <UsageLimitsModal onClose={() => undefined} />,
			},
		],
	}),
];
