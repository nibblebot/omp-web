import { Show, type Component, type JSX } from "solid-js";
import { ThemeLinkButton } from "../web/components/app/ThemeLinkButton";
import { ThemeModeControl } from "../web/components/app/ThemeModeControl";
import { ThemePicker } from "../web/components/app/ThemePicker";
import { state } from "../web/state";

/** The app's own theme controls: Mode, the theme picker (two when unlinked) and the link toggle. */
const ThemeSwitcher: Component = () => (
	<div class="ds-theme">
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

/** Top bar of a standalone page: its brand, the DEMO badge when `demo` is set, theme, then page-specific extras. */
export const TopBar: Component<{ brand: string; demo?: boolean; children?: JSX.Element }> = (
	props,
) => (
	<nav class="ds-topbar">
		<span class="ds-brand">{props.brand}</span>
		<Show when={props.demo}>
			<span
				class="ds-demo-badge"
				title="Demo: fixture data only; no fleet, session, or model runs behind it"
			>
				Demo
			</span>
		</Show>
		<ThemeSwitcher />
		{props.children}
	</nav>
);
