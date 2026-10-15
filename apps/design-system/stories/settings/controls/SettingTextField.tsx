import { SettingTextField } from "../../../../web/components/settings/controls/SettingTextField";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "settings-control-text-field",
		title: "SettingTextField",
		component: {
			file: "apps/web/components/settings/controls/SettingTextField.tsx",
			export: "SettingTextField",
		},
		variants: [
			{
				name: "Value stored",
				render: () => (
					<SettingTextField
						label="Relay URL"
						value="https://relay.example.com"
						onCommit={() => undefined}
					/>
				),
			},
			{
				name: "Not set",
				description: "Empty or null values show the Not set placeholder.",
				render: () => (
					<SettingTextField label="Relay URL" value={null} onCommit={() => undefined} />
				),
			},
			{
				name: "Secret",
				description: "Secret text hides its value until Show is pressed.",
				render: () => (
					<SettingTextField
						label="API key"
						value="sk-live-example"
						secret
						onCommit={() => undefined}
					/>
				),
			},
		],
	}),
];
