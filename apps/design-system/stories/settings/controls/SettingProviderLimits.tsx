import { SettingProviderLimits } from "../../../../web/components/settings/controls/SettingProviderLimits";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "settings-control-provider-limits",
		title: "SettingProviderLimits",
		component: {
			file: "apps/web/components/settings/controls/SettingProviderLimits.tsx",
			export: "SettingProviderLimits",
		},
		variants: [
			{
				name: "One provider limited",
				render: () => (
					<SettingProviderLimits
						label="Max in-flight requests"
						value={{ anthropic: 2 }}
						providers={["anthropic", "openai"]}
						onCommit={() => undefined}
					/>
				),
			},
			{
				name: "Default",
				description: "No provider limited: the summary reads Default.",
				render: () => (
					<SettingProviderLimits
						label="Max in-flight requests"
						value={{}}
						providers={["anthropic", "openai"]}
						onCommit={() => undefined}
					/>
				),
			},
		],
	}),
];
