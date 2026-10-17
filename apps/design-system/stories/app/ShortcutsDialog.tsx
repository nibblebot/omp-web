import { ShortcutsDialog } from "../../../web/components/app/ShortcutsDialog";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-shortcuts-dialog",
	title: "ShortcutsDialog",
	component: { file: "apps/web/components/app/ShortcutsDialog.tsx", export: "ShortcutsDialog" },
	tabs: true,
	variants: [
		{
			name: "Commands (/help)",
			description: "The Help modal opened by /help: slash commands, grouped, on the Commands tab.",
			render: (ctx) => <ShortcutsDialog initialTab="commands" onClose={ctx.close} />,
		},
		{
			name: "Shortcuts (/hotkeys)",
			description: "The Help modal opened by /hotkeys: keyboard shortcuts on the Shortcuts tab.",
			render: (ctx) => <ShortcutsDialog initialTab="shortcuts" onClose={ctx.close} />,
		},
	],
});
