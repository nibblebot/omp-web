import { ThemeLinkButton } from "../../../web/components/app/ThemeLinkButton";
import { seedThemes } from "../../fixtures/themes";
import { defineStory } from "../../registry";

export default defineStory({
	id: "app-theme-link-button",
	title: "ThemeLinkButton",
	component: { file: "apps/web/components/app/ThemeLinkButton.tsx", export: "ThemeLinkButton" },
	tabs: true,
	variants: [
		{
			name: "Linked",
			description:
				"Pressed: one picker sets the theme for both light and dark. Clicking unlinks, keeping both ids.",
			seed: () => seedThemes(),
			render: () => (
				<div class="ds-frame-panel ds-frame-narrow">
					<ThemeLinkButton />
				</div>
			),
		},
		{
			name: "Unlinked",
			description:
				"Released: separate Light and Dark pickers. Clicking relinks both schemes to the family in effect when it has both variants, else to the default theme.",
			seed: () => seedThemes({ linked: false, light: "gruvbox", dark: "dusk-terminal" }),
			render: () => (
				<div class="ds-frame-panel ds-frame-narrow">
					<ThemeLinkButton />
				</div>
			),
		},
	],
});
