import { BtwSheet } from "../../../web/components/requests/BtwSheet";
import { btwAnswered, btwFailed, btwStreaming } from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

export default defineStory({
	id: "requests-btw-sheet",
	title: "BtwSheet",
	component: { file: "apps/web/components/requests/BtwSheet.tsx", export: "BtwSheet" },
	tabs: true,
	variants: [
		{
			name: "Streaming answer",
			seed: { btw: btwStreaming },
			render: () => <BtwSheet />,
		},
		{
			name: "Complete answer",
			seed: { btw: btwAnswered },
			render: () => <BtwSheet />,
		},
		{
			name: "Rate limited",
			seed: { btw: btwFailed },
			render: () => <BtwSheet />,
		},
	],
});
