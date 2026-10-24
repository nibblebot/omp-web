import { SidebarHeader } from "../../../web/components/app/SidebarHeader";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-sidebar-header",
	title: "SidebarHeader",
	component: { file: "apps/web/components/app/SidebarHeader.tsx", export: "SidebarHeader" },
	variants: [
		{
			name: "Chat only",
			description:
				"Wordmark and the collapse toggle; each sidebar passes its own actions (the Chat roster passes the running-only filter).",
			seed: { view: "chat", modal: null },
			render: () => (
				<aside class="sidebar open">
					<SidebarHeader onCollapse={() => {}} />
				</aside>
			),
		},
	],
});
