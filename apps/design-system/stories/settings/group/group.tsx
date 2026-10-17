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
			{
				name: "Collapsible group (narrow)",
				description:
					"Below 768px a collapsible group folds its card behind a 44px header with a caret; wide layouts keep the card open under a plain title.",
				render: () => (
					<SettingsGroup title="Agent SDK" id="sdk-model" collapsible>
						<SettingsRowLayout
							label="Default model"
							description="Used for new sessions in this project."
						>
							<span>gpt-5</span>
						</SettingsRowLayout>
					</SettingsGroup>
				),
			},
		],
	}),
];
