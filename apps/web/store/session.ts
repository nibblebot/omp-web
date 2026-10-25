import { SESSION_REPLACING_METHODS } from "#lib/wire/protocol";
import { state } from "../state";
import { pendingCalls, watchPendingCalls } from "./transport";

/**
 * Session domain (Phase 3 store facade split). The session MIRROR itself,
 * applyState/loadHistory/resetSessionView, deliberately stays in state.ts
 * (it is a cross-domain reset surface the tests drive through the mux); this
 * module owns the session readiness accessor.
 */

/** R8 omp-session readiness accessor: true once the boot session's gate has cleared
 *  (the server broadcast `ready` or stamped readyAt into a state frame). */
export function isReady(): boolean {
	return state.readyAt !== undefined;
}

const REPLACING: Record<string, true> = Object.fromEntries(
	SESSION_REPLACING_METHODS.map((method) => [method, true as const]),
);

/**
 * True while this tab has a session-replacing call (newSession, switchSession,
 * ...) in flight. The session's identity moves ahead of the `sessionScope` this
 * tab holds the moment the SDK mints the new session id, and the tab only learns
 * the new one from the resync that precedes the call's answer, so a send in
 * between would carry the old scope and be refused as a stale attachment (or run
 * on the session being torn down). The composer holds its sends until then.
 */
export function isSessionChanging(): boolean {
	watchPendingCalls();
	for (const pending of pendingCalls.values()) {
		if (REPLACING[pending.cmd.method]) return true;
	}
	return false;
}
