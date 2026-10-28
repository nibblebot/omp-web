import { MainHeader } from "../../../web/components/app/MainHeader";
import { SessionTitle } from "../../../web/components/chat";
import { screenSessionSeed } from "../../fixtures/screen";
import { liveCollabStatus } from "../../fixtures/collab";
import { goalActive } from "../../fixtures/subagents";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-main-header",
	title: "MainHeader",
	component: { file: "apps/web/components/app/MainHeader.tsx", export: "MainHeader" },
	seed: screenSessionSeed,
	variants: [
		{
			name: "Live session",
			description:
				"Session title on the left, then the Appearance button and the settings gear, always rightmost; the sidebar is open.",
			seed: { connected: true, view: "chat", sidebarVisible: true },
			render: () => <MainHeader title={<SessionTitle />} session />,
		},
		{
			name: "Sidebar closed, goal",
			description:
				"The open toggle leads the row; session badges sit before the Appearance button and the gear.",
			seed: {
				connected: true,
				view: "chat",
				sidebarVisible: false,
				goalModeState: goalActive,
			},
			render: () => <MainHeader title={<SessionTitle />} session />,
		},
		{
			name: "Goal and live share",
			description:
				"Header order: title, goal badge, Live badge (only while the session is shared; opens the ShareSheet), Appearance button, settings gear.",
			seed: {
				connected: true,
				view: "chat",
				sidebarVisible: true,
				goalModeState: goalActive,
				collabStatus: liveCollabStatus,
			},
			render: () => <MainHeader title={<SessionTitle />} session />,
		},
		{
			name: "Disconnected, no session",
			description:
				"No-session pane: toggle, Appearance and settings only; the connection bar sits below.",
			seed: { connected: false, view: "chat", sidebarVisible: false },
			render: () => <MainHeader />,
		},
	],
});
