import { ThemeFilesFooter } from "../../../web/components/app/ThemeFilesFooter";
import { setState } from "../../../web/state";
import { seedThemes } from "../../fixtures/themes";
import { defineStory } from "../../registry";

const render = () => (
	<div class="ds-frame-panel ds-frame-narrow">
		<ThemeFilesFooter />
	</div>
);

export default defineStory({
	id: "app-theme-files-footer",
	title: "ThemeFilesFooter",
	component: { file: "apps/web/components/app/ThemeFilesFooter.tsx", export: "ThemeFilesFooter" },
	tabs: true,
	variants: [
		{
			name: "Failures",
			description:
				"The themes folder, Reload themes (it re-reads the folder through the fixture route), and the expandable list of files that failed with each reason.",
			seed: () => seedThemes(),
			render,
		},
		{
			name: "No failures",
			description: "Every file loaded: only the folder and Reload themes.",
			seed: () => {
				seedThemes();
				setState("themes", "failures", []);
			},
			render,
		},
		{
			name: "Reloading",
			description: "A reload is in flight: the button is disabled and a status says so.",
			seed: () => {
				seedThemes();
				setState("themesLoading", true);
			},
			render,
		},
		{
			name: "Reload failed",
			description:
				"The last reload failed: the previous list stays and the error shows under the button.",
			seed: () => {
				seedThemes();
				setState("themesError", "control plane unreachable");
			},
			render,
		},
	],
});
