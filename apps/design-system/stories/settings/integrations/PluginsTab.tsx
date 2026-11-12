import { PluginsTab } from "../../../../web/components/settings/integrations/PluginsTab";
import { setState } from "../../../../web/state";
import { answerCalls } from "../../../session";
import { statusBarRequest } from "../../../fixtures/dialogs";
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
		seed: { currentWorkspaceId: "sess_09a41c" },
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
				name: "Status bars",
				description:
					"The attached session shows a plugin status line: a Status Bars group lists it under the heading the bar shows, with its current text and a toggle that hides it in this browser.",
				seed: () => {
					answerCalls({ listPlugins: () => pluginSummaries, getPluginConfig: () => pluginDetail });
					setState("browserUi", { requests: [statusBarRequest], error: null });
				},
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
