import { TodosPopover } from "../../../web/components/activities/TodosPopover";
import { seedActivityBar, seedTodoOverflow } from "../../fixtures/activity-bar";
import { PopoverAnchor } from "../../fixtures/popover-anchor";
import { defineStory } from "../../registry";

export default defineStory({
	id: "activities-todos-popover",
	title: "TodosPopover",
	component: { file: "apps/web/components/activities/TodosPopover.tsx", export: "TodosPopover" },
	variants: [
		{
			name: "Board mid-run",
			description:
				"The phased checklist, read-only: rows are inert. The popout icon opens the panel at the Todo section.",
			seed: () => seedActivityBar({ todos: "mid-run" }),
			render: () => <PopoverAnchor label="Todo" popover={TodosPopover} />,
		},
		{
			name: "More than eight",
			description:
				'The first eight tasks across the phases, then "+N more", which opens the panel at the section.',
			seed: () => seedTodoOverflow(),
			render: () => <PopoverAnchor label="Todo" popover={TodosPopover} />,
		},
	],
});
