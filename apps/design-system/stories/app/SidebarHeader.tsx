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
				"Wordmark and the collapse toggle; no Chat/Analysis switch while Analysis Mode is in development.",
			seed: { view: "chat", modal: null },
			render: () => (
				<aside class="sidebar open">
					<SidebarHeader onCollapse={() => {}} />
				</aside>
			),
		},
	],
});
