import { SettingOrderedList } from "../../../../web/components/settings/controls/SettingOrderedList";
import { defineStory } from "../../../registry";

const methods = [
	{ value: "summary", label: "Summary", description: "Condense older turns into a summary." },
	{ value: "prune", label: "Prune tool output", description: "Drop large tool results first." },
	{ value: "handoff", label: "Handoff", description: "Hand the session to a fresh context." },
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
				description:
					"Enabled rows are numbered in stored order; the off row sits last. Drag the grip or press Alt+↑/↓ to reorder.",
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
