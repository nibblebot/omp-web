import { CommandPalettePicker } from "../../../web/components/app/CommandPalettePicker";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-command-palette-picker",
	title: "CommandPalettePicker",
	component: {
		file: "apps/web/components/app/CommandPalettePicker.tsx",
		export: "CommandPalettePicker",
	},
	variants: [
		{
			name: "Empty query",
			description:
				"Ctrl+K palette with no query: open targets, commands and recent picks, grouped; typing searches sessions across projects, settings and models.",
			render: (ctx) => <CommandPalettePicker onClose={ctx.close} />,
		},
	],
});
