import { AnnotationsPanel } from "../../../web/components/review/AnnotationsPanel";
import { annotationCalls } from "../../fixtures/review";
import { answerCalls } from "../../session";
import { defineStory } from "../../registry";

export default defineStory({
	id: "review-annotations-panel",
	title: "AnnotationsPanel",
	component: {
		file: "apps/web/components/review/AnnotationsPanel.tsx",
		export: "AnnotationsPanel",
	},
	variants: [
		{
			name: "Annotations",
			description: "One annotation per anchor kind, with one stale and one orphaned anchor.",
			seed: () => answerCalls(annotationCalls()),
			render: () => (
				<div class="ds-frame-tall">
					<AnnotationsPanel />
				</div>
			),
		},
		{
			name: "Empty",
			description: "No annotations yet. The composer is the only content.",
			seed: () => answerCalls(annotationCalls({ rows: [] })),
			render: () => (
				<div class="ds-frame-tall">
					<AnnotationsPanel />
				</div>
			),
		},
		{
			name: "Loading",
			description: "The annotation list request is still in flight.",
			seed: () => answerCalls(annotationCalls({ pending: true })),
			render: () => (
				<div class="ds-frame-tall">
					<AnnotationsPanel />
				</div>
			),
		},
		{
			name: "Load error",
			description: "The session process refused the list request, so the sidebar shows the error.",
			seed: () =>
				answerCalls(
					annotationCalls({ loadError: "annotation store is locked by another session process" }),
				),
			render: () => (
				<div class="ds-frame-tall">
					<AnnotationsPanel />
				</div>
			),
		},
	],
});
