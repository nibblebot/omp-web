import { SESSION_REPLACING_METHODS } from "#lib/wire/protocol";

/**
 * Refuses calls that send user content into the session while a
 * session-replacing call (newSession, switchSession, ...) is running.
 *
 * The SDK mints the new session id partway through such a call and keeps
 * working on the new session (system prompt rebuild, memory reset, hooks)
 * before it returns, and the daemon only broadcasts the new identity after
 * that. A prompt that arrives in between either lands before the id flips and
 * runs on the session being torn down (the resync then wipes it, leaving a
 * blank turn with no error), or lands after and is refused as a stale
 * attachment with advice to refresh. Both are the same gap; this names it.
 */

const REPLACING: Record<string, true> = Object.fromEntries(
	SESSION_REPLACING_METHODS.map((method) => [method, true as const]),
);

export const SESSION_CHANGE_IN_PROGRESS =
	"Session change in progress; retry once the new session is shown";

export interface SessionChangeGate {
	/** Throws {@link SESSION_CHANGE_IN_PROGRESS} when `method` sends into a session that is being replaced. */
	assertOpen(method: string): void;
	/** Runs `run`, counting it as a session change for its whole duration when `method` replaces the session. */
	track<T>(method: string, run: () => Promise<T>): Promise<T>;
}

/** `sendMethods`: the methods that put user content into the session (prompt, steer, ...). */
export function createSessionChangeGate(
	sendMethods: Partial<Record<string, true>>,
): SessionChangeGate {
	let inFlight = 0;
	return {
		assertOpen(method) {
			if (inFlight > 0 && Object.hasOwn(sendMethods, method)) {
				throw new Error(SESSION_CHANGE_IN_PROGRESS);
			}
		},
		async track(method, run) {
			if (!Object.hasOwn(REPLACING, method)) return run();
			inFlight++;
			try {
				return await run();
			} finally {
				inFlight--;
			}
		},
	};
}
