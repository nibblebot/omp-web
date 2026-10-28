import type { Component } from "solid-js";
import { changeThemeLinked, state } from "../../state";
import { LinkIcon, UnlinkIcon } from "../ui/icons";

const LABEL = "Link light and dark themes";

/**
 * Chain toggle beside the theme picker. Pressed (linked): one picker chooses a theme for
 * both schemes. Released: separate Light and Dark pickers. Relinking is the store's rule
 * (changeThemeLinked): both schemes move to the family in effect, else the default.
 */
export const ThemeLinkButton: Component = () => (
	<button
		type="button"
		class="theme-link-btn"
		aria-label={LABEL}
		aria-pressed={state.themeSelection.linked}
		title={state.themeSelection.linked ? "Linked: click to pick light and dark separately" : LABEL}
		onClick={() => changeThemeLinked(!state.themeSelection.linked)}
	>
		{state.themeSelection.linked ? <LinkIcon /> : <UnlinkIcon />}
	</button>
);
