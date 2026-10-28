import type { Component } from "solid-js";
import { THEME_MODES } from "../../prefs/theme";
import { changeThemeMode, state } from "../../state";
import { SettingSegmented } from "../settings/controls/SettingSegmented";

/** System / Light / Dark: which scheme's theme the app wears. System follows the OS color scheme. */
export const ThemeModeControl: Component = () => (
	<SettingSegmented
		label="Mode"
		options={THEME_MODES.map((value) => ({
			value,
			label: value[0]!.toUpperCase() + value.slice(1),
		}))}
		value={state.themeSelection.mode}
		onChange={(value) => {
			const mode = THEME_MODES.find((m) => m === value);
			if (mode) changeThemeMode(mode);
		}}
	/>
);
