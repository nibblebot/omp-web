import { render } from "solid-js/web";
import { App, startBoot } from "./App";
import { preloadShortcutModals } from "./ModalHost";
import { activateFeatures } from "./features/registry";
import { preferredFeatureIds } from "./features/preferences";
import "./styles.css";
import { initTheme } from "./prefs/theme";

// Apply the persisted theme/font-size before first render to avoid a flash. After
// the styles import on purpose: in dev Vite injects CSS from JS, and the theme
// stylesheet must end up after it in <head>.
initTheme();

// Dial the fleet before the first render: roster and history frames land in the
// store while the app mounts, and the data requests leave one round trip sooner.
startBoot();

// Feature entries load in the background (disabled ones are never imported).
// Every slot accessor is reactive on the active set, so overlays, commands and
// tabs appear when their chunk lands; nothing at first paint reads a slot.
void activateFeatures(preferredFeatureIds());

// The static boot shell in index.html stands in until now; the app replaces it in one frame.
const root = document.getElementById("root")!;
root.replaceChildren();
render(() => <App booted />, root);

// The dialogs behind Ctrl+K and Ctrl+, load once the page is idle, not with the entry chunk.
const whenIdle = (): void => {
	if (typeof requestIdleCallback === "function")
		requestIdleCallback(preloadShortcutModals, { timeout: 5000 });
	else setTimeout(preloadShortcutModals, 2000);
};
if (document.readyState === "complete") whenIdle();
else window.addEventListener("load", whenIdle, { once: true });
