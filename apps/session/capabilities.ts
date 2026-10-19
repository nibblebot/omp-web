/**
 * Server capability advertisement. The daemon tells the browser which runtime
 * verdicts it has, via `WebSessionState.capabilities` on the attach priming and
 * every state frame.
 *
 * Only verdicts that depend on the running session belong here. A domain whose
 * methods are always dispatchable is not advertised: the browser calls them
 * unconditionally, so a constant `{available:true}` would only restate the build.
 *
 * The one runtime verdict is git: the review service binds to the session cwd,
 * so a cwd outside any repository advertises `available: false` with the reason
 * instead of a panel that fails on first use. Absent key means unavailable.
 */

import { git } from "@oh-my-pi/pi-natives/vcs";
import type { ServerCapabilities } from "#lib/wire/protocol";
import type { Capability } from "#lib/wire/browser-ui-contract";

/** Opens the repository bound to `cwd`, or null when none is discoverable. */
export type OpenRepo = (cwd: string) => unknown;

/** Runtime verdict for the git review service bound to `cwd`. */
export function gitCapability(cwd: string, openRepo: OpenRepo = git): Capability {
	try {
		if (openRepo(cwd)) return { available: true };
		return { available: false, reason: `not a git repository: ${cwd}` };
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		return { available: false, reason: `git repository unavailable: ${detail}` };
	}
}
