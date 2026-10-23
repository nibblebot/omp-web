import { SidebarHeader } from "../../../web/components/app/SidebarHeader";
import { setFeaturePreference } from "../../../web/features/preferences";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-sidebar-header",
	title: "SidebarHeader",
	component: { file: "apps/web/components/app/SidebarHeader.tsx", export: "SidebarHeader" },
	variants: [
		{
			name: "Chat only",
			description: "Analysis off (the default): wordmark and the collapse toggle; no debug button.",
			seed: { view: "chat", modal: null },
			render: () => (
				<aside class="sidebar open">
					<SidebarHeader onCollapse={() => {}} />
				</aside>
			),
		},
		{
			name: "With Analysis",
			description: "The Chat/Analysis switch sits between the wordmark and the collapse toggle.",
			seed: () => setFeaturePreference("analysis", true),
			render: () => (
				<aside class="sidebar open">
					<SidebarHeader onCollapse={() => {}} />
				</aside>
			),
		},
	],
});
