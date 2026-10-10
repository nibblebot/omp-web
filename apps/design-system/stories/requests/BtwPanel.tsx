import { BtwPanel } from "../../../web/components/requests/BtwPanel";
import { btwAnswered, btwFailed, btwStreaming } from "../../fixtures/dialogs";
import { defineStory } from "../../registry";

export default defineStory({
	id: "requests-btw-panel",
	title: "BtwPanel",
	component: { file: "apps/web/components/requests/BtwPanel.tsx", export: "BtwPanel" },
	tabs: true,
	variants: [
		{
			name: "Streaming answer",
			seed: { btw: btwStreaming },
			render: () => <BtwPanel />,
		},
		{
			name: "Complete answer",
			seed: { btw: btwAnswered },
			render: () => <BtwPanel />,
		},
		{
			name: "Rate limited",
			seed: { btw: btwFailed },
			render: () => <BtwPanel />,
		},
	],
});
