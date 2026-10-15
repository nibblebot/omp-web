import { SettingSegmented } from "../../../../web/components/settings/controls/SettingSegmented";
import { defineStory } from "../../../registry";

const levels = [
	{ value: "off", label: "Off" },
	{ value: "low", label: "Low" },
	{ value: "high", label: "High" },
];

export default [
	defineStory({
		id: "settings-control-segmented",
		title: "SettingSegmented",
		component: {
			file: "apps/web/components/settings/controls/SettingSegmented.tsx",
			export: "SettingSegmented",
		},
		variants: [
			{
				name: "Middle option selected",
				render: () => (
					<SettingSegmented
						label="Thinking"
						options={levels}
						value="low"
						onChange={() => undefined}
					/>
				),
			},
			{
				name: "Disabled",
				render: () => (
					<SettingSegmented
						label="Thinking"
						options={levels}
						value="high"
						disabled
						onChange={() => undefined}
					/>
				),
			},
		],
	}),
];
