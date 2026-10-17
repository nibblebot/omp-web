import { ConnectionBar } from "../../../web/components/app/ConnectionBar";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-connection-bar",
	title: "ConnectionBar",
	component: { file: "apps/web/components/app/ConnectionBar.tsx", export: "ConnectionBar" },
	variants: [
		{
			name: "Reconnecting",
			description:
				"The /events stream is down: the strip says it is reconnecting and session actions are paused.",
			seed: { connected: false, view: "chat", sidebarVisible: false },
			render: () => <ConnectionBar />,
		},
		{
			name: "Offline",
			description:
				"The attached session process is down: the strip says actions are paused until the session restarts.",
			seed: { connected: true, sessionDownId: "daemon-a", view: "chat", sidebarVisible: false },
			render: () => <ConnectionBar />,
		},
	],
});
