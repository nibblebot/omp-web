import { SessionTreePanel } from "../../../web/components/sessions/SessionTreePanel";
import { setState } from "../../../web/state";
import { sessionGraphPage, sessionGraphPageMore } from "../../fixtures/dialogs";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

export default defineStory({
	id: "sessions-session-tree-panel",
	title: "SessionTreePanel",
	component: {
		file: "apps/web/components/sessions/SessionTreePanel.tsx",
		export: "SessionTreePanel",
	},
	tabs: true,
	variants: [
		{
			name: "Tree with fork points",
			seed: () => {
				setState("capabilities", { graph: { available: true } });
				answerCalls({ getSessionGraph: () => sessionGraphPage });
			},
			render: () => <SessionTreePanel />,
		},
		{
			name: "Paged tree",
			seed: () => {
				setState("capabilities", { graph: { available: true } });
				answerCalls({ getSessionGraph: () => sessionGraphPageMore });
			},
			render: () => <SessionTreePanel />,
		},
		{
			name: "Graph unavailable",
			seed: () => {
				setState("capabilities", {
					graph: { available: false, reason: "Upgrade omp to 14.2 to browse the session graph." },
				});
			},
			render: () => <SessionTreePanel />,
		},
		{
			name: "Load failed",
			seed: () => {
				setState("capabilities", { graph: { available: true } });
				answerCalls({
					getSessionGraph: () => {
						throw new Error("revision mismatch: the session changed while the graph loaded");
					},
				});
			},
			render: () => <SessionTreePanel />,
		},
	],
});
