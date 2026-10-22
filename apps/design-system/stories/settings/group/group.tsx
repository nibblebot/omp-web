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
					"A small group title above a flat list of rows; the title is omitted when none is given.",
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
					"Below 768px a collapsible group folds its rows behind a 44px header with a caret; wide layouts keep the group open under a plain title.",
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
			{
				name: "Advanced group (every width)",
				description:
					"The Advanced group of a collapsible tab starts folded on wide layouts too; its header toggles it open.",
				render: () => (
					<SettingsGroup title="Advanced" id="sdk-model-advanced" collapsible>
						<SettingsRowLayout
							label="Request Timeout"
							description="Seconds before a model request is abandoned."
						>
							<span>120</span>
						</SettingsRowLayout>
					</SettingsGroup>
				),
			},
		],
	}),
];
