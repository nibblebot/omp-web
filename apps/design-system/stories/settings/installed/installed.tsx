import { InstalledTab } from "../../../../web/components/settings/InstalledTab";
import { PluginDetailView } from "../../../../web/components/settings/PluginDetail";
import type { PluginDetail, PluginSummary } from "#lib/wire/protocol";
import { answerCalls } from "../../../daemon";
import { defineStory } from "../../../registry";

// One enabled npm plugin with a version, one linked plugin without a version
// (the meta line must omit "v…" rather than print "vundefined").
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

// Covers every control kind the plugin configure view renders: feature
// checkboxes, boolean toggle, bounded number, secret, and enum select.
const detail: PluginDetail = {
	...plugins[0],
	features: [
		{ name: "status line", description: "Adds the usage segment.", enabled: true, default: true },
		{
			name: "cost tracking",
			description: "Adds per-session cost.",
			enabled: false,
			default: false,
		},
	],
	featuresCustomized: true,
	settings: [
		{
			key: "showCost",
			type: "boolean",
			secret: false,
			description: "Show session cost.",
			default: false,
			value: true,
			set: true,
		},
		{
			key: "refreshSeconds",
			type: "number",
			secret: false,
			min: 5,
			max: 300,
			step: 5,
			default: 30,
			set: false,
		},
		{ key: "apiToken", type: "string", secret: true, env: "USAGE_TOKEN", set: false },
		{
			key: "display",
			type: "enum",
			secret: false,
			values: ["compact", "full"],
			default: "compact",
			set: false,
		},
	],
};

export default [
	defineStory({
		id: "settings-installed-tab",
		title: "InstalledTab",
		component: { file: "apps/web/components/settings/InstalledTab.tsx", export: "InstalledTab" },
		seed: { currentSessionId: "sess_09a41c" },
		variants: [
			{
				name: "Plugin cards",
				description:
					"Two installed plugins: one enabled npm plugin with a version, one linked plugin without one.",
				seed: () => answerCalls({ listPlugins: () => plugins }),
				render: () => <InstalledTab />,
			},
			{
				name: "No plugins",
				description: "The lock file lists no plugins.",
				seed: () => answerCalls({ listPlugins: () => [] }),
				render: () => <InstalledTab />,
			},
		],
	}),
	defineStory({
		id: "settings-plugin-detail",
		title: "PluginDetailView",
		component: {
			file: "apps/web/components/settings/PluginDetail.tsx",
			export: "PluginDetailView",
		},
		variants: [
			{
				name: "Configure",
				description: "Feature checkboxes and one control per setting kind.",
				render: (ctx) => <PluginDetailView detail={detail} onBack={ctx.close} />,
			},
		],
	}),
];
