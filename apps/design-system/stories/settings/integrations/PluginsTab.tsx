import { PluginsTab } from "../../../../web/components/settings/integrations/PluginsTab";
import type { PluginSummary } from "#lib/wire/protocol";
import { answerCalls } from "../../../daemon";
import { defineStory } from "../../../registry";

const plugins: PluginSummary[] = [
	{
		name: "omp-usage-status-plugin",
		source: "npm",
		version: "1.4.2",
		enabled: true,
		description: "Shows token usage and cost in the status line.",
	},
	{
		name: "omp-review-kit",
		source: "link",
		enabled: false,
		description: "Review hooks that run inside the agent process.",
	},
];

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
				description: "The CLI install hint above the installed plugin cards.",
				seed: () => answerCalls({ listPlugins: () => plugins }),
				render: () => <PluginsTab />,
			},
			{
				name: "No plugins",
				seed: () => answerCalls({ listPlugins: () => [] }),
				render: () => <PluginsTab />,
			},
		],
	}),
];
