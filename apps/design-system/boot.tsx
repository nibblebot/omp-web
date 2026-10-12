import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { initTheme } from "../web/prefs/theme";
import { FEATURE_IDS } from "../web/features/manifest";
import { activateFeatures } from "../web/features/registry";
// Same global stylesheet production loads (index.tsx), then the showcase chrome.
import "../web/styles.css";
import "./showcase.css";
import { installDaemon } from "./daemon";

/**
 * Shared boot for both standalone pages (`stories.tsx`, `demo.tsx`); each entry
 * imports this module first so the global CSS order holds.
 *
 * Deliberately NOT importing apps/web/index.tsx: its render boots App, whose
 * onMount opens the SSE connection and probes /auth/session. The pages import
 * components and the (side-effect free) store module; only the demo and the App
 * story mount App, against the design server's fixture /events stream.
 */
export function boot(title: string, page: () => JSX.Element): void {
	document.title = title;
	initTheme();
	installDaemon();
	void activateFeatures(FEATURE_IDS).then(() => render(page, document.getElementById("root")!));
}
