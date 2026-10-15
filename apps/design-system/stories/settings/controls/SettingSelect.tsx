import { SettingSelect } from "../../../../web/components/settings/controls/SettingSelect";
import { defineStory } from "../../../registry";

const editModes = [
	{ value: "replace", label: "Replace" },
	{ value: "hashline", label: "Hashline with anchors" },
	{ value: "patch", label: "Unified patch" },
];

export default [
	defineStory({
		id: "settings-control-select",
		title: "SettingSelect",
		component: {
			file: "apps/web/components/settings/controls/SettingSelect.tsx",
			export: "SettingSelect",
		},
		variants: [
			{
				name: "Option chosen",
				render: () => (
					<SettingSelect
						label="Edit mode"
						options={editModes}
						value="hashline"
						onChange={() => undefined}
					/>
				),
			},
			{
				name: "Disabled",
				render: () => (
					<SettingSelect
						label="Edit mode"
						options={editModes}
						value="replace"
						disabled
						onChange={() => undefined}
					/>
				),
			},
		],
	}),
];
