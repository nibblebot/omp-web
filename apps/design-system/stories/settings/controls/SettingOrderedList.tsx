import { SettingOrderedList } from "../../../../web/components/settings/controls/SettingOrderedList";
import { defineStory } from "../../../registry";

const methods = [
	{ value: "summary", label: "Summary" },
	{ value: "prune", label: "Prune tool output" },
	{ value: "handoff", label: "Handoff" },
];

export default [
	defineStory({
		id: "settings-control-ordered-list",
		title: "SettingOrderedList",
		component: {
			file: "apps/web/components/settings/controls/SettingOrderedList.tsx",
			export: "SettingOrderedList",
		},
		variants: [
			{
				name: "Two enabled, one off",
				description: "Enabled rows are numbered in stored order; the off row sits last.",
				render: () => (
					<SettingOrderedList
						label="Compaction methods"
						options={methods}
						selected={["handoff", "summary"]}
						onChange={() => undefined}
					/>
				),
			},
		],
	}),
];
