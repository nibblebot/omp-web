import { ViewSwitch } from "../../../web/components/app/ViewSwitch";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-view-switch",
	title: "ViewSwitch",
	component: { file: "apps/web/components/app/ViewSwitch.tsx", export: "ViewSwitch" },
	variants: [
		{
			name: "Hidden",
			description:
				"Renders nothing: the Chat/Analysis switch stays hidden while Analysis Mode is in development.",
			seed: { view: "chat", chatUnviewed: false },
			render: () => <ViewSwitch />,
		},
	],
});
