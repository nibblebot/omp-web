import { setState, state } from "../state";
import { call } from "./transport";

// ---------------------------------------------------------------------------
// Phase 11: /btw side panel (runEphemeralTurn relay). The panel owns a
// streamId that routes ephemeral_delta frames and abortEphemeral; nothing
// here touches the transcript or the main turn. The delta buffer itself
// (pendingEphemeral) lives in chat.ts — the rAF flush that drains it is
// shared with the transcript machinery, so the ephemeral frames coalesce in
// the same loop.
// ---------------------------------------------------------------------------
let nextEphemeralStreamId = 1;

/** Open the /btw panel and (with a question) start a side-channel turn. */
export function askBtw(question: string): void {
	const q = question.trim();
	if (!q) {
		// Bare /btw: open the panel empty; the hint explains the usage.
		setState("btw", { question: "", reply: "", streaming: false, streamId: -1 });
		return;
	}
	const streamId = nextEphemeralStreamId++;
	setState("btw", { question: q, reply: "", streaming: true, streamId });
	// Long-running side turn: no timeout (0); the panel's stop/close aborts it.
	void call("runEphemeralTurn", [q], 0, streamId)
		.then((result) => {
			const replyText = (result as { replyText?: string } | null)?.replyText ?? "";
			setState("btw", (prev) =>
				prev && prev.streamId === streamId ? { ...prev, reply: replyText, streaming: false } : prev,
			);
		})
		.catch((err) => {
			setState("btw", (prev) =>
				prev && prev.streamId === streamId
					? { ...prev, streaming: false, error: String(err) }
					: prev,
			);
		});
}

/** Close the /btw panel; aborts the in-flight side turn server-side. */
export function closeBtw(): void {
	const current = state.btw;
	setState("btw", null);
	if (current?.streaming && current.streamId >= 0) {
		void call("abortEphemeral", [], 5_000, current.streamId).catch(() => {});
	}
}
