import { ShortcutsDialog } from "../../../web/components/app/ShortcutsDialog";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-shortcuts-dialog",
	title: "ShortcutsDialog",
	component: { file: "apps/web/components/app/ShortcutsDialog.tsx", export: "ShortcutsDialog" },
	tabs: true,
	variants: [
		{
			name: "Keyboard shortcuts",
			description: "The help modal: every composer and transcript shortcut.",
			render: (ctx) => <ShortcutsDialog onClose={ctx.close} />,
		},
	],
});
