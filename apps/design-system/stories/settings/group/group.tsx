import { SettingsGroup } from "../../../../web/components/settings/SettingsGroup";
import { SettingsRowLayout } from "../../../../web/components/settings/SettingsRow";
import { defineStory } from "../../../registry";

export default [
	defineStory({
		id: "settings-group",
		title: "SettingsGroup",
		component: { file: "apps/web/components/settings/SettingsGroup.tsx", export: "SettingsGroup" },
		variants: [
			{
				name: "Titled group",
				description:
					"A group label above a card of rows; the label is omitted when no title is given.",
				render: () => (
					<SettingsGroup title="Modes" id="modes">
						<SettingsRowLayout
							label="Plan Mode"
							description="Enable plan mode for read-only exploration."
						>
							<span>On</span>
						</SettingsRowLayout>
					</SettingsGroup>
				),
			},
		],
	}),
];
