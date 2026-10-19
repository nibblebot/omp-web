import { SessionTreePanel } from "../../../web/components/sessions/SessionTreePanel";
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
				answerCalls({ getSessionGraph: () => sessionGraphPage });
			},
			render: () => <SessionTreePanel />,
		},
		{
			name: "Paged tree",
			seed: () => {
				answerCalls({ getSessionGraph: () => sessionGraphPageMore });
			},
			render: () => <SessionTreePanel />,
		},
		{
			name: "Load failed",
			seed: () => {
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
