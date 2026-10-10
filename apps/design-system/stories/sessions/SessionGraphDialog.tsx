import { SessionGraphDialog } from "../../../web/components/sessions/SessionGraphDialog";
import { setState } from "../../../web/state";
import { sessionGraphPage, sessionGraphPageMore } from "../../fixtures/dialogs";
import { answerCalls } from "../../daemon";
import { defineStory } from "../../registry";

export default defineStory({
	id: "sessions-session-graph-dialog",
	title: "SessionGraphDialog",
	component: {
		file: "apps/web/components/sessions/SessionGraphDialog.tsx",
		export: "SessionGraphDialog",
	},
	tabs: true,
	variants: [
		{
			name: "Graph with fork points",
			seed: () => {
				setState("capabilities", { graph: { available: true } });
				answerCalls({ getSessionGraph: () => sessionGraphPage });
			},
			render: () => <SessionGraphDialog onClose={() => {}} />,
		},
		{
			name: "Paged graph",
			seed: () => {
				setState("capabilities", { graph: { available: true } });
				answerCalls({ getSessionGraph: () => sessionGraphPageMore });
			},
			render: () => <SessionGraphDialog onClose={() => {}} />,
		},
		{
			name: "Legacy daemon header",
			seed: () => {
				setState("capabilities", {
					graph: { available: false, reason: "Upgrade omp to 14.2 to browse the session graph." },
				});
			},
			render: () => <SessionGraphDialog onClose={() => {}} />,
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
			render: () => <SessionGraphDialog onClose={() => {}} />,
		},
	],
});
