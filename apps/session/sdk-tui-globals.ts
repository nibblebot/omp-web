import { ensureThemeSync } from "@oh-my-pi/pi-tui/theme";

/**
 * Process-level terminal-global bootstrap for the web host (called once at boot
 * by index.ts).
 *
 * The browser host renders no TUI, so nothing else initializes the SDK's
 * terminal globals, while SDK code that runs in this process still reads them:
 * - the ask tool shapes its "Done selecting" row from the pi-tui theme
 *   singleton (`theme.status`) before it opens any dialog, so a missing theme
 *   fails the whole tool call with `undefined is not an object (evaluating
 *   'theme.status')`;
 * - ask notifications write OSC/BEL bytes straight to stdout, which this
 *   daemon reserves for OMP_SESSION| contract lines (`<state dir>/session-logs`
 *   captures it), so terminal notifications stay suppressed here; the SDK's own
 *   RPC mode does the same for its stdout protocol channel, and the browser
 *   has its own notification path (apps/web/store/chat.ts).
 *
 * Library theme defaults are deliberate here: the browser renders none of
 * these strings, so the user's theme/symbol settings never need to load before
 * the session exists.
 */
export function initSdkTuiGlobals(): void {
	process.env.PI_NOTIFICATIONS = "off";
	ensureThemeSync();
}
