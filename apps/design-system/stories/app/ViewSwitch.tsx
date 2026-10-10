import { ViewSwitch } from "../../../web/components/app/ViewSwitch";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-view-switch",
	title: "ViewSwitch",
	component: { file: "apps/web/components/app/ViewSwitch.tsx", export: "ViewSwitch" },
	variants: [
		{
			name: "Chat view",
			description: "Chat is the active mode.",
			seed: { view: "chat", chatUnviewed: false },
			render: () => <ViewSwitch />,
		},
		{
			name: "Analysis view",
			description: "Analysis is the active mode.",
			seed: { view: "analysis", chatUnviewed: false },
			render: () => <ViewSwitch />,
		},
		{
			name: "Unviewed chat turn",
			description:
				"A turn ended unattended in Analysis, so the Chat button carries the activity dot.",
			seed: { view: "analysis", chatUnviewed: true },
			render: () => <ViewSwitch />,
		},
	],
});
