import { createUniqueId, Show, type Component } from "solid-js";
import { ThemeLinkButton } from "../web/components/app/ThemeLinkButton";
import { ThemeModeControl } from "../web/components/app/ThemeModeControl";
import { ThemePicker } from "../web/components/app/ThemePicker";
import { PaletteIcon } from "../web/components/ui/icons";
import { state } from "../web/state";

/**
 * The app's own theme controls: Mode, the theme picker (two when unlinked) and the link toggle.
 * A native popover: inline while the bar has room, a panel behind the bar's Theme button where
 * it does not (showcase.css), which light-dismisses and closes on Escape by itself.
 */
const ThemeSwitcher: Component<{ id: string }> = (props) => (
	<div id={props.id} class="ds-theme" popover="auto">
		<ThemeModeControl />
		<Show
			when={state.themeSelection.linked}
			fallback={
				<>
					<ThemePicker kind="light" label="Light theme" floating />
					<ThemePicker kind="dark" label="Dark theme" floating />
				</>
			}
		>
			<ThemePicker kind="linked" label="Theme" floating />
		</Show>
		<ThemeLinkButton />
	</div>
);

/**
 * Top bar of the stories page: its brand, theme, then the Theme button at the end that shows
 * only when the theme controls collapse. The demo page has no top bar (demo.tsx).
 */
export const TopBar: Component<{ brand: string }> = (props) => {
	const themeId = createUniqueId();
	return (
		<nav class="ds-topbar">
			<span class="ds-brand">{props.brand}</span>
			<ThemeSwitcher id={themeId} />
			<div class="ds-topbar-end">
				<button
					type="button"
					class="ds-theme-toggle"
					popovertarget={themeId}
					aria-label="Theme"
					title="Theme"
				>
					<PaletteIcon />
				</button>
			</div>
		</nav>
	);
};
