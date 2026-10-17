import { SessionTreeDialog } from "../../../web/components/sessions/SessionTreeDialog";
import { setState } from "../../../web/state";
import { sessionGraphPage, sessionGraphPageMore } from "../../fixtures/dialogs";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

export default defineStory({
	id: "sessions-session-tree-dialog",
	title: "SessionTreeDialog",
	component: {
		file: "apps/web/components/sessions/SessionTreeDialog.tsx",
		export: "SessionTreeDialog",
	},
	tabs: true,
	variants: [
		{
			name: "Tree with fork points",
			seed: () => {
				setState("capabilities", { graph: { available: true } });
				answerCalls({ getSessionGraph: () => sessionGraphPage });
			},
			render: (ctx) => <SessionTreeDialog onClose={ctx.close} />,
		},
		{
			name: "Paged tree",
			seed: () => {
				setState("capabilities", { graph: { available: true } });
				answerCalls({ getSessionGraph: () => sessionGraphPageMore });
			},
			render: (ctx) => <SessionTreeDialog onClose={ctx.close} />,
		},
		{
			name: "Graph unavailable",
			seed: () => {
				setState("capabilities", {
					graph: { available: false, reason: "Upgrade omp to 14.2 to browse the session graph." },
				});
			},
			render: (ctx) => <SessionTreeDialog onClose={ctx.close} />,
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
			render: (ctx) => <SessionTreeDialog onClose={ctx.close} />,
		},
	],
});
