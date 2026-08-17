import { state } from "../state";

/**
 * Session domain (Phase 3 store facade split). The session MIRROR itself —
 * applyState/loadHistory/resetSessionView — deliberately stays in state.ts
 * (it is a cross-domain reset surface the tests drive through the mux); this
 * module owns the session readiness accessor.
 */

/** R8 omp-session readiness accessor: true once the boot session's gate has cleared
 *  (the server broadcast `ready` or stamped readyAt into a state frame). */
export function isReady(): boolean {
	return state.readyAt !== undefined;
}
