import type { PluginDetail, PluginSummary } from "#lib/wire/protocol";

/**
 * listPlugins answer: one enabled npm plugin with a version, one linked plugin without a version
 * (the meta line must omit "v…" rather than print "vundefined").
 */
export const pluginSummaries: PluginSummary[] = [
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

/**
 * getPluginConfig answer for the first plugin. Covers every control kind the configure view renders:
 * feature toggles, boolean toggle, bounded number, text, secret, and enum select.
 */
export const pluginDetail: PluginDetail = {
	...pluginSummaries[0],
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
			key: "endpoint",
			type: "string",
			secret: false,
			description: "Usage API base URL.",
			default: "https://usage.example.com",
			value: "https://usage.internal.example.com",
			set: true,
		},
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
