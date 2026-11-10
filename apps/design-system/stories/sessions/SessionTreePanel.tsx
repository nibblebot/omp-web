import { SessionTreePanel } from "../../../web/components/sessions/SessionTreePanel";
import {
	sessionGraphAskProbe,
	sessionGraphPage,
	sessionGraphPageAsk,
	sessionGraphPageMore,
} from "../../fixtures/dialogs";
import { answerCalls } from "../../session";
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
			name: "Re-answering an ask",
			description:
				"Select the ask answer and choose Navigate here: the session probes, then asks in the composer, so the panel shows a pending note. The demo cancels the question after a few seconds.",
			seed: () => {
				answerCalls({
					getSessionGraph: () => sessionGraphPageAsk,
					navigateTree: () => sessionGraphAskProbe,
					reanswerAsk: () => {
						const { promise, resolve } = Promise.withResolvers<unknown>();
						setTimeout(
							() => resolve({ cancelled: true, revision: sessionGraphAskProbe.revision }),
							6000,
						);
						return promise;
					},
				});
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
