import { TranscriptViewMenu } from "../../../../web/components/chat/transcript/TranscriptViewMenu";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "chat-transcript-view-menu",
	title: "TranscriptViewMenu",
	component: {
		file: "apps/web/components/chat/transcript/TranscriptViewMenu.tsx",
		export: "TranscriptViewMenu",
	},
	variants: [
		{
			name: "Collapsed cards",
			description:
				"Narrow-column replacement for the transcript toolbar; renders only below 768px wide.",
			seed: { toolCardsView: "collapsed", toolsExpanded: false },
			render: () => <TranscriptViewMenu />,
		},
	],
});
