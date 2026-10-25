import { PlanReviewPanel } from "../../../web/components/review/PlanReviewPanel";
import { planCalls, reviewPlanChangesRequested } from "../../fixtures/review";
import { answerCalls } from "../../session";
import { defineStory } from "../../registry";

export default defineStory({
	id: "review-plan-review-panel",
	title: "PlanReviewPanel",
	component: { file: "apps/web/components/review/PlanReviewPanel.tsx", export: "PlanReviewPanel" },
	variants: [
		{
			name: "Waiting for review",
			description: "The plan is waiting for an approve, request-changes, or cancel decision.",
			seed: () => answerCalls(planCalls()),
			render: () => (
				<div class="ds-frame-tall">
					<PlanReviewPanel />
				</div>
			),
		},
		{
			name: "Changes requested",
			description: "The plan was sent back with a note. Reopen is offered instead of a decision.",
			seed: () => answerCalls(planCalls({ plan: reviewPlanChangesRequested })),
			render: () => (
				<div class="ds-frame-tall">
					<PlanReviewPanel />
				</div>
			),
		},
		{
			name: "No plan",
			description: "No plan is pending for this session: the panel renders nothing.",
			seed: () => answerCalls(planCalls({ plan: null })),
			render: () => (
				<div class="ds-frame-tall">
					<PlanReviewPanel />
				</div>
			),
		},
		{
			name: "Decision refused",
			description:
				"Press approve or request changes to see the session process refuse a stale decision.",
			seed: () =>
				answerCalls(
					planCalls({ decisionError: "plan version 3 is stale; reload before deciding" }),
				),
			render: () => (
				<div class="ds-frame-tall">
					<PlanReviewPanel />
				</div>
			),
		},
		{
			name: "Load error",
			description: "The plan request failed, so the panel shows the error.",
			seed: () => answerCalls(planCalls({ loadError: "plan review service is not running" })),
			render: () => (
				<div class="ds-frame-tall">
					<PlanReviewPanel />
				</div>
			),
		},
		{
			name: "Loading",
			description: "The plan request is still in flight.",
			seed: () => answerCalls(planCalls({ pending: true })),
			render: () => (
				<div class="ds-frame-tall">
					<PlanReviewPanel />
				</div>
			),
		},
	],
});
