// Saved /btw side questions of the attached session: the list, the selected
// thread's transcript pages, promotion eligibility, copy, cancel. The live
// answer (the question being streamed right now) lives in store/btw.ts and
// `state.btw`; this module owns the saved side only.
//
// Local signals (not in the shared store): view state of the /btw sheet.
// Uplinks go through `call` from ./transport. The server owns durable state
// (apps/session/btw-history-adapter.ts). Late answers from a prior attachment
// are dropped by the scope guard (each settle re-checks state.sessionId).
//
// Wire args are positional, as apps/session/methods.ts reads them: btwList
// [{limit}], btwSearch [query, {limit}], btwPage [recordId, afterKey, limit],
// btwCancel / btwCopy / btwPromotePreview / btwPromote [recordId].

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

function readTranscriptPage(data: unknown): {
	turns: BtwTranscriptTurnView[];
	total: number;
	nextAfter?: string;
} {
	const root = asRecord(data);
	const list = root !== null && Array.isArray(root.turns) ? root.turns : [];
	const turns: BtwTranscriptTurnView[] = [];
	for (const item of list) {
		const turn = normalizeTranscriptTurn(item);
		if (turn) turns.push(turn);
	}
	return {
		turns,
		total: root !== null && typeof root.total === "number" ? root.total : turns.length,
		...(root !== null && typeof root.nextAfter === "string" ? { nextAfter: root.nextAfter } : {}),
	};
}

/** The record id from a btwStart / btwFollowUp result (`{record}`), or null. */
export function btwRecordId(data: unknown): string | null {
	const record = asRecord(asRecord(data)?.record);
	return record !== null && typeof record.id === "string" && record.id ? record.id : null;
}

/** The newest turn of a record: its last follow-up, else the record itself. */
export function latestBtwTurn(record: BtwRecordView): BtwTurnView {
	return record.followUps?.at(-1) ?? record;
}

// ---------------------------------------------------------------------------
// Mirror signals (local; the shared store is untouched).
// ---------------------------------------------------------------------------

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
const [btwPreview, setBtwPreview] = createSignal<BtwPromotePreviewView | null>(null);
const [btwPreviewLoading, setBtwPreviewLoading] = createSignal(false);
const [btwPromoting, setBtwPromoting] = createSignal(false);

export {
	btwHistoryRecords,
	btwHistoryTotal,
	btwHistoryLoading,
	btwHistoryError,
	btwHistoryNotice,
	btwSearchQuery,
	btwSelectedId,
	btwTranscript,
	btwPreview,
	btwPreviewLoading,
	btwPromoting,
};

/** True while the /btw sheet is open: only then does a running turn get polled. */
let viewOpen = false;
let btwPollTimer = 0;
/** Ids that were running at the last list read; a running to settled flip reloads the open thread. */
let runningIds = new Set<string>();

function stopBtwPoll(): void {
	if (btwPollTimer !== 0) {
		window.clearTimeout(btwPollTimer);
		btwPollTimer = 0;
	}
}

/**
 * Apply a fresh list. While the sheet is open and a turn is still running,
 * keep polling; a running to settled flip reloads the open thread. The live
 * stream of this tab (state.btw) never polls: its settle path refreshes.
 */
function applyRecords(records: BtwRecordView[], total: number, scope: string): void {
	setBtwHistoryRecords(records);
	setBtwHistoryTotal(total);
	const selected = btwSelectedId();
	if (selected !== null && !records.some((record) => record.id === selected)) {
		setBtwSelectedId(null);
	}
	const nowRunning = new Set(
		records
			.filter((record) => latestBtwTurn(record).status === "running")
			.map((record) => record.id),
	);
	const settledSelected =
		selected !== null && runningIds.has(selected) && !nowRunning.has(selected);
	runningIds = nowRunning;
	stopBtwPoll();
	if (viewOpen && nowRunning.size > 0 && state.btw === null) {
		btwPollTimer = window.setTimeout(() => {
			btwPollTimer = 0;
			if (state.sessionId === scope && viewOpen) refreshBtwHistory();
		}, 1500);
	}
	if (settledSelected) selectBtwRecord(selected);
}

/** Re-list the attached session's saved side questions. Scope-guarded: answers
 *  that arrive after a session switch are dropped, never applied to the new session. */
export function refreshBtwHistory(): void {
	if (btwSearchQuery().trim()) {
		searchBtwHistory(btwSearchQuery());
		return;
	}
	const scope = state.sessionId;
	setBtwHistoryLoading(true);
	void call("btwList", [{ limit: 50 }])
		.then((data) => {
			if (state.sessionId !== scope) return;
			const { records, total } = normalizeRecords(data);
			applyRecords(records, total, scope);
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			setBtwHistoryError(errText(err));
		})
		.finally(() => {
			if (state.sessionId === scope) setBtwHistoryLoading(false);
		});
}

/** The sheet opened: re-list the saved side questions and enable polling. */
export function rediscoverBtwHistory(): void {
	viewOpen = true;
	runningIds = new Set();
	stopBtwPoll();
	setBtwHistoryError(null);
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
	void call("btwSearch", [needle, { limit: 50 }])
		.then((data) => {
			if (state.sessionId !== scope) return;
			const { records, total } = normalizeRecords(data);
			applyRecords(records, total, scope);
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			setBtwHistoryError(errText(err));
		})
		.finally(() => {
			if (state.sessionId === scope) setBtwHistoryLoading(false);
		});
}

/**
 * Select a record (null = no saved thread open), load its first transcript
 * page, and read the promotion eligibility so the Promote action can say why
 * it is unavailable.
 */
export function selectBtwRecord(id: string | null): void {
	setBtwSelectedId(id);
	setBtwPreview(null);
	if (id === null) {
		setBtwTranscript({ recordId: "", turns: [], total: 0, loading: false });
		return;
	}
	setBtwTranscript({ recordId: id, turns: [], total: 0, loading: true });
	const scope = state.sessionId;
	void call("btwPage", [id, null, 20])
		.then((data) => {
			if (state.sessionId !== scope || btwSelectedId() !== id) return;
			setBtwTranscript({ recordId: id, ...readTranscriptPage(data), loading: false });
			previewPromoteBtw(id);
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			setBtwHistoryError(errText(err));
			setBtwTranscript({ recordId: id, turns: [], total: 0, loading: false });
		});
}

/** Append the next transcript page for the selected record (cursor paging). */
export function pageBtwTranscript(): void {
	const current = btwTranscript();
	if (current.loading || current.nextAfter === undefined) return;
	const scope = state.sessionId;
	setBtwTranscript({ ...current, loading: true });
	void call("btwPage", [current.recordId, current.nextAfter, 20])
		.then((data) => {
			if (state.sessionId !== scope || btwTranscript().recordId !== current.recordId) return;
			const page = readTranscriptPage(data);
			const appended = [...current.turns];
			for (const turn of page.turns) {
				if (!appended.some((existing) => existing.key === turn.key)) appended.push(turn);
			}
			setBtwTranscript({
				recordId: current.recordId,
				turns: appended,
				total: page.total,
				...(page.nextAfter !== undefined ? { nextAfter: page.nextAfter } : {}),
				loading: false,
			});
		})
		.catch((err) => {
			if (state.sessionId !== scope || isSessionSwitchSupersession(err)) return;
			setBtwHistoryError(errText(err));
			setBtwTranscript({ ...current, loading: false });
		});
}

/** Copy a record's current answer text (server-resolved; with a notice when the
 *  clipboard refuses). */
export function copyBtw(recordId: string): void {
	setBtwHistoryError(null);
	setBtwHistoryNotice(null);
	void call("btwCopy", [recordId])
		.then((data) => {
			const root = asRecord(data);
			const text = root !== null && typeof root.text === "string" ? root.text : "";
			if (!text) {
				setBtwHistoryNotice("Nothing to copy: this side question has no answer text yet.");
				return;
			}
			void copyText(text).then((ok) => {
				setBtwHistoryNotice(
					ok
						? "Copied the answer to the clipboard."
						: "Copy failed: the clipboard is unavailable here. Select the answer text manually.",
				);
			});
		})
		.catch((err) => {
			if (isSessionSwitchSupersession(err)) return;
			setBtwHistoryError(errText(err));
		});
}

/** Read-only promotion eligibility (never mutates, never moves the session). */
function previewPromoteBtw(recordId: string): void {
	setBtwPreview(null);
	setBtwPreviewLoading(true);
	void call("btwPromotePreview", [recordId])
		.then((data) => {
			if (btwSelectedId() !== recordId) return;
			setBtwPreview(normalizePreview(data, recordId));
		})
		.catch((err) => {
			if (isSessionSwitchSupersession(err)) return;
			setBtwHistoryError(errText(err));
		})
		.finally(() => setBtwPreviewLoading(false));
}

/**
 * Server-owned promotion: the client sends only the record id. On success the
 * daemon branches this Q/A pair into the session transcript and every tab
 * resyncs. Resolves true when the transcript changed.
 */
export async function promoteBtw(recordId: string): Promise<boolean> {
	if (btwPromoting()) return false;
	setBtwPromoting(true);
	setBtwHistoryError(null);
	try {
		const data = await call("btwPromote", [recordId], 60_000);
		if (asRecord(data)?.cancelled === true) {
			setBtwHistoryNotice("A session hook cancelled the promotion; the transcript is unchanged.");
			return false;
		}
		setBtwHistoryNotice(
			"Promoted to the transcript: this side question is now part of the session.",
		);
		return true;
	} catch (err) {
		if (isSessionSwitchSupersession(err)) return false;
		setBtwHistoryError(errText(err));
		return false;
	} finally {
		setBtwPromoting(false);
	}
}

/** Close the sheet (presentation only): selection and polling stop, saved turns stay. */
export function closeBtwHistory(): void {
	viewOpen = false;
	stopBtwPoll();
	runningIds = new Set();
	setBtwSelectedId(null);
	setBtwPreview(null);
	setBtwTranscript({ recordId: "", turns: [], total: 0, loading: false });
}

/**
 * Abort a running side question (saved turns survive as `cancelled`). With a
 * record id, that record is cancelled; without one (the live question's id is
 * not known until it settles), the running record is looked up from the list.
 */
export function stopBtwTurn(recordId?: string): void {
	const scope = state.sessionId;
	const resolve: Promise<string | undefined> =
		recordId !== undefined
			? Promise.resolve(recordId)
			: call("btwList", [{ limit: 50 }]).then(
					(data) =>
						normalizeRecords(data).records.find(
							(record) => latestBtwTurn(record).status === "running",
						)?.id,
				);
	void resolve
		.then((id) => (id === undefined ? undefined : call("btwCancel", [id])))
		.then(() => {
			if (state.sessionId === scope) refreshBtwHistory();
		})
		.catch((err) => {
			if (isSessionSwitchSupersession(err)) return;
			setBtwHistoryError(errText(err));
		});
}

/** Dismiss the current error/notice. */
export function dismissBtwHistoryStatus(): void {
	setBtwHistoryError(null);
	setBtwHistoryNotice(null);
}
