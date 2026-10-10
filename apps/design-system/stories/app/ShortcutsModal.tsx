import { ShortcutsModal } from "../../../web/components/app/ShortcutsModal";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-shortcuts-modal",
	title: "ShortcutsModal",
	component: { file: "apps/web/components/app/ShortcutsModal.tsx", export: "ShortcutsModal" },
	tabs: true,
	variants: [
		{
			name: "Keyboard shortcuts",
			description: "The help modal: every composer and transcript shortcut.",
			render: () => <ShortcutsModal onClose={() => undefined} />,
		},
	],
});
