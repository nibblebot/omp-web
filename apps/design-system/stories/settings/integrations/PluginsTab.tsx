import { PluginsTab } from "../../../../web/components/settings/integrations/PluginsTab";
import { answerCalls } from "../../../daemon";
import { pluginDetail, pluginSummaries } from "../../../fixtures/plugins";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "settings-integrations-plugins-tab",
		title: "PluginsTab",
		component: {
			file: "apps/web/components/settings/integrations/PluginsTab.tsx",
			export: "PluginsTab",
		},
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Plugins",
				description:
					"The CLI install hint above two installed plugins as flat settings rows: one enabled npm plugin with a version, one linked plugin without one. Configure expands the detail under its row.",
				seed: () =>
					answerCalls({ listPlugins: () => pluginSummaries, getPluginConfig: () => pluginDetail }),
				render: () => <PluginsTab />,
			},
			{
				name: "No plugins",
				description: "The lock file lists no plugins.",
				seed: () => answerCalls({ listPlugins: () => [] }),
				render: () => <PluginsTab />,
			},
		],
	}),
];
