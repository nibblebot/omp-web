import { EmptyTranscript } from "../../../../web/components/chat/transcript/EmptyTranscript";
import { screenSessionSeed } from "../../../fixtures/screen";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-transcript-empty-transcript",
	title: "EmptyTranscript",
	component: {
		file: "apps/web/components/chat/transcript/EmptyTranscript.tsx",
		export: "EmptyTranscript",
	},
	seed: screenSessionSeed,
	variants: [
		{
			name: "Model synced",
			description: "A fresh session: the model's character greets the user.",
			seed: { modelSynced: true },
			render: () => <EmptyTranscript />,
		},
		{
			name: "Waiting for the model",
			description:
				"Before the state frame lands the pane stays blank, so no wrong character flashes.",
			seed: { modelSynced: false },
			render: () => <EmptyTranscript />,
		},
	],
});
