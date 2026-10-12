import { render } from "solid-js/web";
import { App } from "./App";
import { activateFeatures } from "./features/registry";
import { preferredFeatureIds } from "./features/preferences";
import "./styles.css";

// Feature entries load before the first render, so every slot is settled
// before any component reads it. Disabled features are never imported.
void activateFeatures(preferredFeatureIds()).then(() => {
	render(() => <App />, document.getElementById("root")!);
});
