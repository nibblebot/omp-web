import type { JSX } from "solid-js";
import { ThemePicker } from "../../../web/components/app/ThemePicker";
import { ThemeLinkButton } from "../../../web/components/app/ThemeLinkButton";
import { setState } from "../../../web/state";
import { seedThemes } from "../../fixtures/themes";
import { defineStory } from "../../registry";

/** The panel width the Appearance popover gives a picker. */
const Panel = (props: { children: JSX.Element }) => (
	<div class="ds-frame-panel ds-frame-narrow">{props.children}</div>
);

export default defineStory({
	id: "app-theme-picker",
	title: "ThemePicker",
	component: { file: "apps/web/components/app/ThemePicker.tsx", export: "ThemePicker" },
	tabs: true,
	variants: [
		{
			name: "Linked",
			description:
				"One row per theme, split into a dark and a light half that each paint in their own colors. Gruvbox is a modified built-in; Dusk Terminal has only a dark variant (picking it unlinks). The selected row has the accent outline and a check.",
			seed: () => seedThemes(),
			render: () => (
				<Panel>
					<div class="theme-controls">
						<ThemePicker kind="linked" label="Theme" defaultOpen />
						<ThemeLinkButton />
					</div>
				</Panel>
			),
		},
		{
			name: "Unlinked",
			description:
				"Separate Light theme and Dark theme pickers: full-width single-variant rows listing every theme that has that variant (Dusk Terminal appears only under Dark).",
			seed: () => seedThemes({ linked: false, light: "gruvbox", dark: "everforest" }),
			render: () => (
				<Panel>
					<ThemeLinkButton />
					<ThemePicker kind="light" label="Light theme" defaultOpen />
					<ThemePicker kind="dark" label="Dark theme" defaultOpen />
				</Panel>
			),
		},
		{
			name: "Selected theme unavailable",
			description:
				"The stored dark theme was deleted: the app renders the default, the notice names the stored id, and the choice is kept until another theme is picked.",
			seed: () => seedThemes({ linked: false, dark: "removed-theme" }),
			render: () => (
				<Panel>
					<ThemePicker kind="dark" label="Dark theme" />
				</Panel>
			),
		},
		{
			name: "Collapsed",
			description: "The trigger alone: the selected theme with its dark and light swatches.",
			seed: () => seedThemes(),
			render: () => (
				<Panel>
					<ThemePicker kind="linked" label="Theme" />
				</Panel>
			),
		},
		{
			name: "Themes unavailable",
			description:
				"The fleet has not answered `/ctl/themes`: the trigger is disabled and says why.",
			seed: () => {
				seedThemes();
				setState({ themes: null, themesError: "fleet unreachable" });
			},
			render: () => (
				<Panel>
					<ThemePicker kind="linked" label="Theme" />
				</Panel>
			),
		},
	],
});
