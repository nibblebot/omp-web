import { createSignal, Show } from "solid-js";
import { AppearancePopover } from "../../../web/components/app/AppearancePopover";
import { PaletteIcon } from "../../../web/components/ui/icons";
import { setState } from "../../../web/state";
import { seedAppearanceSettings } from "../../fixtures/appearance";
import { seedThemes } from "../../fixtures/themes";
import { answerCalls } from "../../session";
import { defineStory } from "../../registry";

/** The header's Appearance button owning its popover, as MainHeader does. */
function HeaderAnchored() {
	const [anchor, setAnchor] = createSignal<HTMLElement>();
	const [open, setOpen] = createSignal(true);
	return (
		<header class="main-header">
			<div class="main-header-title">omp-web</div>
			<button
				type="button"
				class="main-header-btn"
				ref={setAnchor}
				title="Appearance"
				aria-label="Appearance"
				aria-haspopup="dialog"
				aria-expanded={open()}
				onClick={() => setOpen(!open())}
			>
				<PaletteIcon />
			</button>
			<Show when={open() ? anchor() : undefined}>
				{(el) => <AppearancePopover anchor={el()} onClose={() => setOpen(false)} />}
			</Show>
		</header>
	);
}

export default defineStory({
	id: "app-appearance-popover",
	title: "AppearancePopover",
	component: { file: "apps/web/components/app/AppearancePopover.tsx", export: "AppearancePopover" },
	tabs: true,
	variants: [
		{
			name: "Defaults",
			description:
				"Groups in order: Theme & text, Transcript, Status, Motion, Sidebar. Theme & text holds the Mode control, the theme picker with its link toggle, the themes footer (folder, Reload themes, failed files) and Font Size. Toggles apply live; the SDK rows write like the Settings sheet did, the browser rows persist under omp.display.* and omp.sidebar*. Show Turn Time stays blocked until Show Token Usage is on.",
			seed: () => {
				seedAppearanceSettings();
				seedThemes();
			},
			render: () => <HeaderAnchored />,
		},
		{
			name: "Unlinked themes",
			description:
				"The chain toggle is released: Light theme and Dark theme pickers, each listing the themes that have that variant, with Mode set to Light.",
			seed: () => {
				seedAppearanceSettings();
				seedThemes({ mode: "light", linked: false, light: "gruvbox", dark: "everforest" });
			},
			render: () => <HeaderAnchored />,
		},
		{
			name: "Selected theme unavailable",
			description:
				"The stored dark theme file is gone: the picker says so, the app renders the default for that scheme, and the stored id is kept.",
			seed: () => {
				seedAppearanceSettings();
				seedThemes({ linked: false, dark: "removed-theme" });
			},
			render: () => <HeaderAnchored />,
		},
		{
			name: "Preferences on",
			description: "Soft Fade and both sidebar row options on; the same rows from the store.",
			seed: () => {
				seedAppearanceSettings();
				seedThemes();
				setState("display", "softFade", true);
				setState({ sidebarSessionTitleLines: 2, sidebarTitleFirst: true, sidebarUsage: false });
			},
			render: () => <HeaderAnchored />,
		},
		{
			name: "Settings loading",
			description:
				"The session's settings have not arrived: the SDK rows are replaced by a note, the browser rows work.",
			seed: () => {
				seedThemes();
				setState("currentWorkspaceId", "sess_09a41c");
				answerCalls({ getSettings: () => Promise.withResolvers<unknown>().promise });
			},
			render: () => <HeaderAnchored />,
		},
	],
});
