import { setState, state } from "../state";
import { call, isSessionSwitchSupersession } from "./transport";
import { btwRecordId, refreshBtwHistory, selectBtwRecord } from "./btw-history";

// ---------------------------------------------------------------------------
// /btw side questions. Every question is a saved record (btwStart /
// btwFollowUp), so it lands in the history, can be followed up, and can be
// promoted into the transcript. The live answer streams into `state.btw`
// through ephemeral_delta frames keyed by the streamId sent with the call.
// Closing the sheet is presentation only: a running question keeps running
// and shows as running in the history until it settles.
// ---------------------------------------------------------------------------
let nextBtwStreamId = 1;

/** Start a fresh side question (`/btw <question>` or the sheet's input). */
export function askBtw(question: string): void {
	const q = question.trim();
	if (q) runBtwTurn("btwStart", [q], q);
}

/** Append a follow-up turn to a saved side question. */
export function followUpBtw(recordId: string, question: string): void {
	const q = question.trim();
	if (q) runBtwTurn("btwFollowUp", [recordId, q], q);
}

function runBtwTurn(method: "btwStart" | "btwFollowUp", args: unknown[], question: string): void {
	const streamId = nextBtwStreamId++;
	const scope = state.sessionId;
	setState("btw", { question, reply: "", streaming: true, streamId });
	// Long-running side turn: no timeout (0). The session settles the record
	// (complete, cancelled or error) and returns it.
	void call(method, args, 0, streamId)
		.then((result) => {
			if (state.sessionId !== scope) return;
			const owned = state.btw?.streamId === streamId;
			if (owned) setState("btw", null);
			refreshBtwHistory();
			const id = btwRecordId(result);
			if (owned && id !== null) selectBtwRecord(id);
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			if (state.btw?.streamId === streamId) {
				setState("btw", (prev) =>
					prev ? { ...prev, streaming: false, error: String(err) } : prev,
				);
			}
			refreshBtwHistory();
		});
}

/** Clear a settled live answer (error or reply) from the sheet. */
export function dismissBtw(): void {
	if (!state.btw?.streaming) setState("btw", null);
}

/** `/btw [question]`: bare opens the sheet; a question starts a side turn. Surrounding blank lines are trimmed. */
export function btwDispatch(args: string): { kind: "sheet" } | { kind: "ask"; question: string } {
	const q = args.trim();
	return q ? { kind: "ask", question: q } : { kind: "sheet" };
}
