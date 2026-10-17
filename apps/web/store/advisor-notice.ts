import { isFeatureEnabled, setFeatureEnabled } from "../features/registry";
import { state } from "../state";
import { pushToast } from "./toasts";

/** Sessions that already showed the notice on this page load. */
const noticedSessions = new Set<string>();

/** The notice is the only way back to hidden advisor notes, so it outlives the default toast delay. */
const NOTICE_MS = 30_000;

/**
 * Advisor notes arrived while the browser feature is off. Their cards would be
 * swallowed silently, so raise one notice per session that offers to turn the
 * feature on. `count` is the notes in the batch (a live card, or a whole
 * replayed history). No-op when the feature is on, when `count` is 0, or when
 * this session has already been noticed.
 */
export function noticeAdvisorNotesWhileOff(count: number): void {
	if (count <= 0 || isFeatureEnabled("advisor")) return;
	const sessionId = state.currentSessionId;
	if (noticedSessions.has(sessionId)) return;
	noticedSessions.add(sessionId);
	const noun = count === 1 ? "note" : "notes";
	pushToast(`The advisor left ${count} ${noun}; show advisor in the browser?`, {
		action: {
			label: "Show advisor in the browser",
			run: () => void setFeatureEnabled("advisor", true),
		},
		durationMs: NOTICE_MS,
	});
}
