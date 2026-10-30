import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import { initTheme } from "../web/prefs/theme";
import { ENABLEABLE_FEATURE_IDS } from "../web/features/manifest";
import { activateFeatures } from "../web/features/registry";
import { reloadThemes } from "../web/state";
// Same global stylesheet production loads (index.tsx), then the showcase chrome.
import "../web/styles.css";
import "./showcase.css";
import { installSession } from "./session";

/**
 * Shared boot for both standalone pages (`stories.tsx`, `demo.tsx`); each entry
 * imports this module first so the global CSS order holds.
 *
 * Deliberately NOT importing apps/web/index.tsx: its render boots App, whose
 * onMount opens the browser socket and probes /auth/session. The pages import
 * components and the (side-effect free) store module; only the demo and the App
 * story mount App, against the in-page fake socket (fake-socket.ts) that
 * `installSession` installs at boot.
 */
export function boot(title: string, page: () => JSX.Element): void {
	document.title = title;
	initTheme();
	// Before the first fetch: the in-page hook answers fixture routes (session.ts).
	installSession();
	// The stories' top bar and the demo App read the theme list from the fixture /ctl/themes.
	void reloadThemes();
	// Only what the app can enable: an in-development feature (Analysis) is never active here.
	void activateFeatures(ENABLEABLE_FEATURE_IDS).then(() =>
		render(page, document.getElementById("root")!),
	);
}
