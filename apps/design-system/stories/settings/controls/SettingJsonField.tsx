import { SettingJsonField } from "../../../../web/components/settings/controls/SettingJsonField";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "settings-control-json-field",
		title: "SettingJsonField",
		component: {
			file: "apps/web/components/settings/controls/SettingJsonField.tsx",
			export: "SettingJsonField",
		},
		variants: [
			{
				name: "List",
				render: () => (
					<SettingJsonField
						label="Skill paths"
						type="list"
						value={["~/skills", "/srv/team/skills"]}
						onCommit={() => undefined}
					/>
				),
			},
			{
				name: "Record",
				render: () => (
					<SettingJsonField
						label="Environment"
						type="record"
						value={{ RUST_LOG: "info", HTTP_PROXY: "http://proxy:3128" }}
						onCommit={() => undefined}
					/>
				),
			},
			{
				name: "Empty list",
				render: () => (
					<SettingJsonField label="Skill paths" type="list" value={[]} onCommit={() => undefined} />
				),
			},
		],
	}),
];
