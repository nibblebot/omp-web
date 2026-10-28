import { ThemeModeControl } from "../../../web/components/app/ThemeModeControl";
import { seedThemes } from "../../fixtures/themes";
import { defineStory } from "../../registry";

const render = () => (
	<div class="ds-frame-panel ds-frame-narrow">
		<ThemeModeControl />
	</div>
);

export default defineStory({
	id: "app-theme-mode-control",
	title: "ThemeModeControl",
	component: { file: "apps/web/components/app/ThemeModeControl.tsx", export: "ThemeModeControl" },
	tabs: true,
	variants: [
		{
			name: "System",
			description:
				"Follows the OS color scheme: the light theme under a light OS, the dark theme under a dark one.",
			seed: () => seedThemes({ mode: "system" }),
			render,
		},
		{
			name: "Light",
			description: "Always the light theme; the whole page repaints.",
			seed: () => seedThemes({ mode: "light" }),
			render,
		},
		{
			name: "Dark",
			description: "Always the dark theme; the whole page repaints.",
			seed: () => seedThemes({ mode: "dark" }),
			render,
		},
	],
});
