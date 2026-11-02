import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgOutEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

/**
 * `out://` replies are on in the SDK's interactive TUI and off elsewhere: with `out.enabled`
 * unset, the SDK follows the `tuiTranscript` session option (`outRepliesActive`, internal-urls/out-protocol.ts).
 * The web draws replies in its transcript like the TUI does, so a session process holds the row's
 * default as a soft pin: a runtime override of the registry default that holds only while no layer
 * configures `out.enabled`. It never writes config.yml, a global write or unset of the row and a
 * disk reload that configures it drop the pin (the user's value wins, live), and every session
 * of this process reads the same `Settings`, so /new, resume and session switches inherit it.
 * `tuiTranscript` stays off on purpose: it would also turn on the Mermaid, SVG and graph prompt hints.
 * Subagents read the same pin through their settings overlay, but the SDK still refuses their
 * `out://` writes (`taskDepth > 0`), so their replies stay with their result.
 *
 * The SDK does not re-pin after a pin is dropped, so callers re-assert it where a session starts or the
 * row is unset: pinning is a no-op while any layer configures the row.
 */
export function pinOutRepliesDefault(settings: Settings): void {
	cfgOutEnabled.pinDefault(settings);
}

/** {@link pinOutRepliesDefault} for the settings of a session about to be replaced or switched; a stand-in session without settings has nothing to pin. */
export function holdOutRepliesDefault(session: { settings?: Settings }): void {
	if (session.settings !== undefined) pinOutRepliesDefault(session.settings);
}
