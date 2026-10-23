import { MainHeader } from "../../../web/components/app/MainHeader";
import { SessionTitle, ToolCardsMenu } from "../../../web/components/chat";
import { screenSessionSeed } from "../../fixtures/screen";
import { goalActive } from "../../fixtures/subagents";
import { subagentMap } from "../../fixtures/session";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-main-header",
	title: "MainHeader",
	component: { file: "apps/web/components/app/MainHeader.tsx", export: "MainHeader" },
	seed: screenSessionSeed,
	variants: [
		{
			name: "Live session",
			description: "Session title on the left, settings gear rightmost; the sidebar is open.",
			seed: { connected: true, view: "chat", sidebarVisible: true },
			render: () => <MainHeader title={<SessionTitle />} actions={<ToolCardsMenu />} session />,
		},
		{
			name: "Sidebar closed, goal and subagents",
			description: "The open toggle leads the row; session badges sit before the gear.",
			seed: {
				connected: true,
				view: "chat",
				sidebarVisible: false,
				goalModeState: goalActive,
				subagents: subagentMap,
			},
			render: () => <MainHeader title={<SessionTitle />} actions={<ToolCardsMenu />} session />,
		},
		{
			name: "Disconnected, no session",
			description: "No-session pane: toggle and settings only; the connection bar sits below.",
			seed: { connected: false, view: "chat", sidebarVisible: false },
			render: () => <MainHeader />,
		},
	],
});
