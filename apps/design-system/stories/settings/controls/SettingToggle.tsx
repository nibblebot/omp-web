import { SettingToggle } from "../../../../web/components/settings/controls/SettingToggle";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "settings-control-toggle",
		title: "SettingToggle",
		component: {
			file: "apps/web/components/settings/controls/SettingToggle.tsx",
			export: "SettingToggle",
		},
		variants: [
			{
				name: "Off",
				render: () => (
					<SettingToggle label="Auto-compact" checked={false} onChange={() => undefined} />
				),
			},
			{
				name: "On",
				render: () => <SettingToggle label="Auto-compact" checked onChange={() => undefined} />,
			},
			{
				name: "Disabled",
				description: "Set by project config: the switch shows the value and cannot change.",
				render: () => (
					<SettingToggle label="Auto-compact" checked disabled onChange={() => undefined} />
				),
			},
		],
	}),
];
