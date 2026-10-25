import { createSignal, For, Show, type Component, type JSX } from "solid-js";
import {
	currentThemePreference,
	setTheme,
	THEME_OPTIONS,
	type ThemePreference,
} from "../web/prefs/theme";

const ThemeSwitcher: Component = () => {
	const [pref, setPref] = createSignal<ThemePreference>(currentThemePreference());
	return (
		<label class="ds-theme">
			<span>Theme</span>
			<select
				value={pref()}
				onChange={(e) => setPref(setTheme(e.currentTarget.value as ThemePreference))}
			>
				<For each={THEME_OPTIONS}>{(opt) => <option value={opt.id}>{opt.label}</option>}</For>
			</select>
		</label>
	);
};

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
