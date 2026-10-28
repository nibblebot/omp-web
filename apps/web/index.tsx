import { render } from "solid-js/web";
import { App } from "./App";
import { activateFeatures } from "./features/registry";
import { preferredFeatureIds } from "./features/preferences";
import "./styles.css";
import { initTheme } from "./prefs/theme";

// Apply the persisted theme/font-size before first render to avoid a flash. After
// the styles import on purpose: in dev Vite injects CSS from JS, and the theme
// stylesheet must end up after it in <head>.
initTheme();

// Feature entries load before the first render, so every slot is settled
// before any component reads it. Disabled features are never imported.
void activateFeatures(preferredFeatureIds()).then(() => {
	render(() => <App />, document.getElementById("root")!);
});
