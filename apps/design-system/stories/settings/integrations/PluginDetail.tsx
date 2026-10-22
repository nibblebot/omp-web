import { PluginDetailView } from "../../../../web/components/settings/integrations/PluginDetail";
import { pluginDetail } from "../../../fixtures/plugins";
import { defineStory } from "../../../registry";

export default defineStory({
	id: "settings-plugin-detail",
	title: "PluginDetailView",
	component: {
		file: "apps/web/components/settings/integrations/PluginDetail.tsx",
		export: "PluginDetailView",
	},
	variants: [
		{
			name: "Configure",
			description:
				"The body that expands under a Plugins row: a status row, a Features group with toggle rows, and a Settings group with one control per setting kind.",
			render: () => <PluginDetailView detail={pluginDetail} />,
		},
		{
			name: "Loading",
			description: "Configure was just pressed and the plugin config has not arrived.",
			render: () => <PluginDetailView detail={null} />,
		},
	],
});
