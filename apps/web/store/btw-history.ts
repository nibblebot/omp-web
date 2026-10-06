// G09 durable BTW history web store (the durable-history upgrade of the
// ephemeral /btw panel in store/btw.ts, which stays untouched).
//
// Client mirror in transient local signals (state.ts untouched: no new keys
// there, no draft mutation — typing a follow-up never touches the Main prompt
// draft). Reads `state` (sessionId for draft scoping) and uplinks through the
// existing `call` relay from ./transport (id-keyed, dedup-safe replays,
// call_result answers). Server owns all durable agent state; this module owns
// the normalized mirror; the component owns transient presentation only.
//
// Draft ownership is partitioned by `${sessionId}/${recordId}`: switching
// sessions never leaks a follow-up draft into another scope, and resnapshots
// (refresh/search/poll) never clear unsent drafts. Late answers from a prior
// attachment are dropped by the scope guard (each settle re-checks
// state.sessionId before applying). Main leaf is never moved client-side:
// confirmPromoteBtw only reports the server's {cancelled, sessionFile}.
//
// WIRING NOTE (for the integrator): this module is intentionally NOT
// registered in overlays/index or App. To mount the surface, render
// BtwHistoryView from components/overlays/BtwHistoryView.tsx and call
// rediscoverBtwHistory() on attach/ready (new connections re-list saved side
// sessions) — state.ts owns the mux, so the re-list hook lives with the
// attach settle, not here. Streaming turns poll btwList until the call
// settles: ephemeral_delta frames for history streamIds are dropped by the
// state.ts mux guard today (it only routes the ephemeral panel's streamId),
// so polling is the transport until P0 approves a mux relaxation.
//
// PROPOSED wire methods (OMP_PROTO stays 2; additive-only). Each call site
// casts its name `as WebMethodName` with a P0-TODO comment. P0 canonicalize:
// the canonical DTOs live in apps/session/btw-history-adapter.ts (BtwRecordPage,
// BtwTranscriptPage, BtwPromotePreview, BtwPromoteResult + cursor shapes).
// Capability gating: pre-P0 servers reject with unknown-method and the mirror
// reports {available:false} with an explicit message instead of failing.

import { createSignal } from "solid-js";
import { state } from "../state";
import { copyText } from "../text/clipboard";
import { call, isSessionSwitchSupersession } from "./transport";

// ---------------------------------------------------------------------------
// View shapes (normalized from untrusted server payloads; never thrown).
// ---------------------------------------------------------------------------

export type BtwTurnStatus = "running" | "complete" | "cancelled" | "error" | "interrupted";

export interface BtwTurnView {
	question: string;
	answer: string;
	status: BtwTurnStatus;
	createdAt: number;
	updatedAt: number;
	error?: string;
}

export interface BtwRecordView extends BtwTurnView {
	id: string;
	leafId: string | null;
	followUps?: BtwTurnView[];
}

export interface BtwTranscriptTurnView extends BtwTurnView {
	key: string;
	index: number;
}

export interface BtwPromotePreviewView {
	recordId: string;
	question: string;
	leafId: string | null;
	sessionId: string;
	eligible: boolean;
	reason?: string;
	turns: number;
}

const TURN_STATUSES: ReadonlyArray<BtwTurnStatus> = [
	"running",
	"complete",
	"cancelled",
	"error",
	"interrupted",
];

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** True when the daemon rejects the call because the method itself does not
 *  exist (pre-P0 server): the slice is unavailable, not broken. */
function isUnknownMethod(err: unknown): boolean {
	return /unknown method|no such method|method not found|unknown call|not implemented/i.test(
		errText(err),
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeTurn(value: unknown): BtwTurnView | null {
	const record = asRecord(value);
	if (!record || typeof record.question !== "string" || typeof record.answer !== "string") {
		return null;
	}
	const status =
		typeof record.status === "string" &&
		(TURN_STATUSES as ReadonlyArray<string>).includes(record.status)
			? (record.status as BtwTurnStatus)
			: "error";
	const turn: BtwTurnView = {
		question: record.question,
		answer: record.answer,
		status,
		createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
		updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : 0,
	};
	if (typeof record.error === "string" && record.error) turn.error = record.error;
	return turn;
}

function normalizeRecord(value: unknown): BtwRecordView | null {
	const turn = normalizeTurn(value);
	const record = asRecord(value);
	if (!turn || !record || typeof record.id !== "string" || !record.id) return null;
	const view: BtwRecordView = {
		...turn,
		id: record.id,
		leafId: typeof record.leafId === "string" ? record.leafId : null,
	};
	if (Array.isArray(record.followUps)) {
		const turns: BtwTurnView[] = [];
		for (const item of record.followUps) {
			const followUp = normalizeTurn(item);
			if (followUp) turns.push(followUp);
		}
		if (turns.length > 0) view.followUps = turns;
	}
	return view;
}

function normalizeRecords(data: unknown): { records: BtwRecordView[]; total: number } {
	const root = asRecord(data);
	const list = root !== null && Array.isArray(root.records) ? root.records : [];
	const records: BtwRecordView[] = [];
	for (const item of list) {
		const view = normalizeRecord(item);
		if (view) records.push(view);
	}
	const total = root !== null && typeof root.total === "number" ? root.total : records.length;
	return { records, total };
}

function normalizeTranscriptTurn(value: unknown): BtwTranscriptTurnView | null {
	const turn = normalizeTurn(value);
	const record = asRecord(value);
	if (!turn || !record || typeof record.key !== "string" || typeof record.index !== "number") {
		return null;
	}
	return { ...turn, key: record.key, index: record.index };
}

function normalizePreview(data: unknown, recordId: string): BtwPromotePreviewView | null {
	const record = asRecord(data);
	if (!record || typeof record.eligible !== "boolean") return null;
	return {
		recordId: typeof record.recordId === "string" ? record.recordId : recordId,
		question: typeof record.question === "string" ? record.question : "",
		leafId: typeof record.leafId === "string" ? record.leafId : null,
		sessionId: typeof record.sessionId === "string" ? record.sessionId : "",
		eligible: record.eligible,
		...(typeof record.reason === "string" && record.reason ? { reason: record.reason } : {}),
		turns: typeof record.turns === "number" ? record.turns : 0,
	};
}

// ---------------------------------------------------------------------------
// Mirror signals (local; state.ts untouched).
// ---------------------------------------------------------------------------

const [btwHistoryAvailable, setBtwHistoryAvailable] = createSignal<boolean | null>(null);
const [btwHistoryRecords, setBtwHistoryRecords] = createSignal<BtwRecordView[]>([]);
const [btwHistoryTotal, setBtwHistoryTotal] = createSignal(0);
const [btwHistoryLoading, setBtwHistoryLoading] = createSignal(false);
const [btwHistoryError, setBtwHistoryError] = createSignal<string | null>(null);
const [btwHistoryNotice, setBtwHistoryNotice] = createSignal<string | null>(null);
const [btwSearchQuery, setBtwSearchQuery] = createSignal("");
const [btwSelectedId, setBtwSelectedId] = createSignal<string | null>(null);
const [btwTranscript, setBtwTranscript] = createSignal<{
	recordId: string;
	turns: BtwTranscriptTurnView[];
	total: number;
	nextAfter?: string;
	loading: boolean;
}>({ recordId: "", turns: [], total: 0, loading: false });
/** Follow-up drafts, keyed `${sessionId}/${recordId}`: unsent, scoped, and
 *  never cleared by resnapshots. */
const [btwDrafts, setBtwDrafts] = createSignal<Record<string, string>>({});
/** Record ids with a turn streaming from this view (polled until settle). */
const [btwStreaming, setBtwStreaming] = createSignal<Record<string, true>>({});
const [btwPreview, setBtwPreview] = createSignal<BtwPromotePreviewView | null>(null);
const [btwPreviewLoading, setBtwPreviewLoading] = createSignal(false);
const [btwPromoting, setBtwPromoting] = createSignal(false);
const [btwPromoteResult, setBtwPromoteResult] = createSignal<{
	cancelled: boolean;
	sessionFile?: string;
} | null>(null);

export {
	btwHistoryAvailable,
	btwHistoryRecords,
	btwHistoryTotal,
	btwHistoryLoading,
	btwHistoryError,
	btwHistoryNotice,
	btwSearchQuery,
	btwSelectedId,
	btwTranscript,
	btwDrafts,
	btwStreaming,
	btwPreview,
	btwPreviewLoading,
	btwPromoting,
	btwPromoteResult,
};

/** Draft scope key: session id partitions drafts across Main/focus views. */
function draftScope(): string {
	return state.sessionId || "unscoped";
}

function draftKey(recordId: string): string {
	return `${draftScope()}/${recordId}`;
}

/** Read one follow-up draft (empty when never typed). */
export function btwDraft(recordId: string): string {
	return btwDrafts()[draftKey(recordId)] ?? "";
}

/** Store one follow-up draft (scoped, unsent; survives resnapshots). */
export function setBtwDraft(recordId: string, text: string): void {
	const key = draftKey(recordId);
	setBtwDrafts((prev) => {
		if (text) return { ...prev, [key]: text };
		const next = { ...prev };
		delete next[key];
		return next;
	});
}

function clearBtwDraft(recordId: string): void {
	setBtwDraft(recordId, "");
}

function markUnavailable(method: string): void {
	setBtwHistoryAvailable(false);
	setBtwHistoryError(
		`BTW history is unavailable: this server does not implement ${method} (proposed for P0). ` +
			"The ephemeral /btw panel still works; saved history needs a newer daemon.",
	);
}

// Stream ids for history turns live far above the ephemeral panel's sequence
// (store/btw.ts starts at 1) so the two never collide on ephemeral_delta.
let nextBtwHistoryStreamId = 1_000_000;
let btwPollTimer = 0;

function stopBtwPoll(): void {
	if (btwPollTimer !== 0) {
		window.clearInterval(btwPollTimer);
		btwPollTimer = 0;
	}
}

function noteSuperseded(): void {
	setBtwStreaming({});
	stopBtwPoll();
	setBtwHistoryLoading(false);
}

/** Re-list the attached session's saved side sessions (rediscovery entry for
 *  attach/ready wiring + view open). Scope-guarded: answers that arrive after
 *  a session switch are dropped, never applied to the new session. */
export function refreshBtwHistory(): void {
	const scope = state.sessionId;
	setBtwHistoryLoading(true);
	setBtwHistoryError(null);
	// Note: btwList is canonical P0 row.
	void call("btwList", [{ limit: 50 }])
		.then((data) => {
			if (state.sessionId !== scope) return;
			setBtwHistoryAvailable(true);
			const { records, total } = normalizeRecords(data);
			setBtwHistoryRecords(records);
			setBtwHistoryTotal(total);
			if (btwSelectedId() !== null && !records.some((record) => record.id === btwSelectedId())) {
				setBtwSelectedId(null);
			}
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			if (isUnknownMethod(err)) markUnavailable("btwList");
			else setBtwHistoryError(errText(err));
		})
		.finally(() => {
			if (state.sessionId === scope) setBtwHistoryLoading(false);
		});
}

/** Rediscover saved side sessions on a new connection (attach/ready). The
 *  integrator calls this where the attach settles; it is a re-list, never a
 *  mutation, so calling it twice is harmless. */
export function rediscoverBtwHistory(): void {
	setBtwStreaming({});
	stopBtwPoll();
	refreshBtwHistory();
}

/** Search across question/answer (server-side); empty query restores the list. */
export function searchBtwHistory(query: string): void {
	setBtwSearchQuery(query);
	const scope = state.sessionId;
	const needle = query.trim();
	if (!needle) {
		refreshBtwHistory();
		return;
	}
	setBtwHistoryLoading(true);
	setBtwHistoryError(null);
	// Note: btwSearch is canonical P0 row.
	void call("btwSearch", [{ query: needle, limit: 50 }])
		.then((data) => {
			if (state.sessionId !== scope) return;
			setBtwHistoryAvailable(true);
			const { records, total } = normalizeRecords(data);
			setBtwHistoryRecords(records);
			setBtwHistoryTotal(total);
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			if (isUnknownMethod(err)) markUnavailable("btwSearch");
			else setBtwHistoryError(errText(err));
		})
		.finally(() => {
			if (state.sessionId === scope) setBtwHistoryLoading(false);
		});
}

/** Select a record and load the first transcript page (stable turn keys). */
export function selectBtwRecord(id: string | null): void {
	setBtwSelectedId(id);
	setBtwPreview(null);
	setBtwPromoteResult(null);
	if (id === null) {
		setBtwTranscript({ recordId: "", turns: [], total: 0, loading: false });
		return;
	}
	setBtwTranscript({ recordId: id, turns: [], total: 0, loading: true });
	const scope = state.sessionId;
	// Note: btwPage is canonical P0 row.
	void call("btwPage", [{ recordId: id, limit: 20 }])
		.then((data) => {
			if (state.sessionId !== scope || btwSelectedId() !== id) return;
			const root = asRecord(data);
			const list = root !== null && Array.isArray(root.turns) ? root.turns : [];
			const turns: BtwTranscriptTurnView[] = [];
			for (const item of list) {
				const turn = normalizeTranscriptTurn(item);
				if (turn) turns.push(turn);
			}
			setBtwTranscript({
				recordId: id,
				turns,
				total: root !== null && typeof root.total === "number" ? root.total : turns.length,
				...(root !== null && typeof root.nextAfter === "string"
					? { nextAfter: root.nextAfter }
					: {}),
				loading: false,
			});
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			if (isUnknownMethod(err)) {
				markUnavailable("btwPage");
				setBtwTranscript({ recordId: id, turns: [], total: 0, loading: false });
			} else {
				setBtwHistoryError(errText(err));
				setBtwTranscript({ recordId: id, turns: [], total: 0, loading: false });
			}
		});
}

/** Append the next transcript page for the selected record (cursor paging). */
export function pageBtwTranscript(): void {
	const current = btwTranscript();
	if (current.loading || current.nextAfter === undefined) return;
	const scope = state.sessionId;
	setBtwTranscript({ ...current, loading: true });
	// Note: btwPage is canonical P0 row.
	void call("btwPage", [{ recordId: current.recordId, afterKey: current.nextAfter, limit: 20 }])
		.then((data) => {
			if (state.sessionId !== scope || btwTranscript().recordId !== current.recordId) return;
			const root = asRecord(data);
			const list = root !== null && Array.isArray(root.turns) ? root.turns : [];
			const appended = [...current.turns];
			for (const item of list) {
				const turn = normalizeTranscriptTurn(item);
				if (turn && !appended.some((existing) => existing.key === turn.key)) appended.push(turn);
			}
			setBtwTranscript({
				recordId: current.recordId,
				turns: appended,
				total: root !== null && typeof root.total === "number" ? root.total : appended.length,
				...(root !== null && typeof root.nextAfter === "string"
					? { nextAfter: root.nextAfter }
					: {}),
				loading: false,
			});
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			if (isUnknownMethod(err)) markUnavailable("btwPage");
			else setBtwHistoryError(errText(err));
			setBtwTranscript({ ...current, loading: false });
		});
}

function pollWhileStreaming(scope: string): void {
	stopBtwPoll();
	btwPollTimer = window.setInterval(() => {
		if (state.sessionId !== scope || Object.keys(btwStreaming()).length === 0) {
			stopBtwPoll();
			return;
		}
		// Note: btwList is canonical P0 row.
		void call("btwList", [{ limit: 50 }])
			.then((data) => {
				if (state.sessionId !== scope) return;
				const { records, total } = normalizeRecords(data);
				setBtwHistoryRecords(records);
				setBtwHistoryTotal(total);
			})
			.catch(() => {});
	}, 1500);
}

/** Append a follow-up turn to a record (epoch-rotated server-side). The draft
 *  clears only on dispatch; a failed send keeps the text for retry. */
export function followUpBtw(recordId: string): void {
	const question = btwDraft(recordId).trim();
	if (!question || btwStreaming()[recordId]) return;
	const scope = state.sessionId;
	setBtwHistoryError(null);
	setBtwStreaming((prev) => ({ ...prev, [recordId]: true }));
	pollWhileStreaming(scope);
	const streamId = nextBtwHistoryStreamId++;
	// Note: btwFollowUp is canonical P0 row.
	void call("btwFollowUp", [{ recordId, question }], 0, streamId)
		.then(() => {
			if (state.sessionId !== scope) return;
			clearBtwDraft(recordId);
			setBtwStreaming((prev) => {
				const next = { ...prev };
				delete next[recordId];
				return next;
			});
			if (Object.keys(btwStreaming()).length === 0) stopBtwPoll();
			if (btwSearchQuery().trim()) searchBtwHistory(btwSearchQuery());
			else refreshBtwHistory();
			if (btwSelectedId() === recordId) selectBtwRecord(recordId);
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) {
				if (isSessionSwitchSupersession(err)) noteSuperseded();
				return;
			}
			setBtwStreaming((prev) => {
				const next = { ...prev };
				delete next[recordId];
				return next;
			});
			if (Object.keys(btwStreaming()).length === 0) stopBtwPoll();
			if (isUnknownMethod(err)) markUnavailable("btwFollowUp");
			else setBtwHistoryError(errText(err));
		});
}

/** Copy a record's current answer text (server-resolved; permission-aware
 *  with a fallback notice when the clipboard refuses). */
export function copyBtw(recordId: string): void {
	setBtwHistoryError(null);
	setBtwHistoryNotice(null);
	// Note: btwCopy is canonical P0 row.
	void call("btwCopy", [{ recordId }])
		.then((data) => {
			const root = asRecord(data);
			const text = root !== null && typeof root.text === "string" ? root.text : "";
			if (!text) {
				setBtwHistoryNotice("Nothing to copy: this record has no answer text yet.");
				return;
			}
			void copyText(text).then((ok) => {
				setBtwHistoryNotice(
					ok
						? "Copied /btw answer to clipboard."
						: "Copy failed: the clipboard is unavailable here. Select the answer text manually.",
				);
			});
		})
		.catch((err) => {
			if (isSessionSwitchSupersession(err)) return;
			if (isUnknownMethod(err)) markUnavailable("btwCopy");
			else setBtwHistoryError(errText(err));
		});
}

/** Read-only guarded-promotion preview (never mutates, never moves Main). */
export function previewPromoteBtw(recordId: string): void {
	setBtwPreview(null);
	setBtwPromoteResult(null);
	setBtwPreviewLoading(true);
	// Note: btwPromotePreview is canonical P0 row.
	void call("btwPromotePreview", [{ recordId }])
		.then((data) => {
			const preview = normalizePreview(data, recordId);
			if (preview) setBtwPreview(preview);
			else setBtwHistoryError("Promotion preview came back in an unknown shape.");
		})
		.catch((err) => {
			if (isSessionSwitchSupersession(err)) return;
			if (isUnknownMethod(err)) markUnavailable("btwPromotePreview");
			else setBtwHistoryError(errText(err));
		})
		.finally(() => setBtwPreviewLoading(false));
}

/** Server-owned promotion only: the client never supplies the assistant
 *  payload (only the recordId) and never moves the Main leaf itself. On
 *  success the result names the new session file for the operator to adopt
 *  through the normal session switch flow. */
export function confirmPromoteBtw(recordId: string): void {
	if (btwPromoting()) return;
	setBtwPromoting(true);
	setBtwHistoryError(null);
	// Note: btwPromote is canonical P0 row.
	void call("btwPromote", [{ recordId }], 60_000)
		.then((data) => {
			const root = asRecord(data);
			setBtwPromoteResult({
				cancelled: root !== null && root.cancelled === true,
				...(root !== null && typeof root.sessionFile === "string"
					? { sessionFile: root.sessionFile }
					: {}),
			});
			setBtwPreview(null);
			refreshBtwHistory();
		})
		.catch((err) => {
			if (isSessionSwitchSupersession(err)) return;
			if (isUnknownMethod(err)) markUnavailable("btwPromote");
			else setBtwHistoryError(errText(err));
		})
		.finally(() => setBtwPromoting(false));
}

/**
 * Close the history view (presentation only). A streaming turn keeps running
 * server-side — closing a completed panel is not deletion, and closing during
 * work follows stop behavior without losing saved turns (reopen to read the
 * answer). Distinct from stopBtwTurn, which aborts the work itself.
 */
export function closeBtwHistory(): void {
	setBtwSelectedId(null);
	setBtwPreview(null);
}

/**
 * Stop a running turn (running-only abort; saved turns survive as
 * `cancelled`). Distinct from closeBtwHistory, which only puts the view away.
 */
export function stopBtwTurn(recordId: string): void {
	// Note: btwCancel is canonical P0 row.
	void call("btwCancel", [{ recordId }])
		.then(() => {
			setBtwStreaming((prev) => {
				const next = { ...prev };
				delete next[recordId];
				return next;
			});
			if (Object.keys(btwStreaming()).length === 0) stopBtwPoll();
			if (btwSearchQuery().trim()) searchBtwHistory(btwSearchQuery());
			else refreshBtwHistory();
		})
		.catch((err) => {
			if (isSessionSwitchSupersession(err)) {
				noteSuperseded();
				return;
			}
			if (isUnknownMethod(err)) markUnavailable("btwCancel");
			else setBtwHistoryError(errText(err));
		});
}

/** Dismiss the current error/notice (view-local; never touches drafts). */
export function dismissBtwHistoryStatus(): void {
	setBtwHistoryError(null);
	setBtwHistoryNotice(null);
}
