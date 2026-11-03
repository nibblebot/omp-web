// G09 persistent BTW/history/follow-up/promotion: server-owned durable BTW
// service over the SDK BtwHistoryStore + AgentSession.
//
// REUSE (never reimplemented here):
//   - `BtwHistoryStore.open(artifactsDir, scope)` / `getRecords()` / `upsert()`
//     / `retry()` / `flush()` (@oh-my-pi/pi-coding-agent/session/btw-history;
//     scope = session id because workers share the artifact root; atomic
//     writes, byte-CAS revision, writer leases, no live-writer steal;
//     running -> interrupted recovery is view-only).
//   - `BtwHistoryRecord{id, leafId, question, answer, status, createdAt,
//     updatedAt, error?, followUps?}`, `BtwHistoryTurn`, `getBtwLatestTurn()` /
//     `getBtwTurns()` / `getBtwCopyText()`
//     (@oh-my-pi/pi-tui/overlays/btw-history).
//   - BtwController rules (modes/controllers/btw-controller.ts): session-ID
//     scope, branch guards (single-turn only, main-session only, idle,
//     unchanged sessionId/leafId, persisted), follow-up reopens record history
//     with transport-epoch rotation, copy = current answer text, cancel =
//     running-only abort, close-vs-stop (closing completed panel is not
//     deletion; closing during work follows stop behavior without losing saved
//     turns), flush-before-lifecycle-move, rediscover on new connections.
//
// Secrets/tokens never appear in DTOs/logs here. stdout stays reserved for
// OMP_SESSION| lines; log via stderr only.

import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	BtwHistoryStore,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwRecordInject,
	getBtwTurnKey,
	getBtwTurns,
	type BtwHistoryRecord,
	type BtwHistoryTurn,
} from "@oh-my-pi/pi-coding-agent/session/btw-history";
import { cfgBtwInject } from "@oh-my-pi/pi-coding-agent/modes/settings";
import {
	beginBtwTurn,
	patchLatestBtwTurn,
	runBtwTurn,
} from "@oh-my-pi/pi-coding-agent/session/btw-turn";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { toError } from "@oh-my-pi/pi-utils";

/** Where a turn's steering prompt (its closed `<inject>` block) stands. A turn without a state
 * has no sendable block: asked while `btw.inject` was off, answered in an earlier run, or an
 * answer with no closed block. `pending` is sendable; `sent` was admitted by the main session. */
export type BtwInjectState = "pending" | "sending" | "sent";

/**
 * Inject state per answer turn (`getBtwTurnKey`), the SDK controller's `#injects`
 * (modes/controllers/btw-controller.ts). Only a turn answered in this process with the inject
 * instruction and a closed block gets an entry, so history from an earlier run, or an answer
 * asked while injecting was off, never sends. Record ids are unique, so the map is shared by
 * every session's service and outlives a session change, as the SDK's does.
 */
const injects = new Map<string, "ready" | "sending" | "sent">();

/** How a turn's block shows: sent, pending on the latest turn (sendable or in flight), else plain text. */
function injectStateOf(record: BtwHistoryRecord, turnIndex: number): BtwInjectState | undefined {
	const state = injects.get(getBtwTurnKey(record, turnIndex));
	if (state === "sent") return "sent";
	if (state === undefined || turnIndex !== getBtwTurns(record).length - 1) return undefined;
	return state === "sending" ? "sending" : "pending";
}

/** Wire shape of one saved turn. Attached images (base64 payloads) never ride
 * the wire; `imageCount` says how many the turn carries. `inject` is the turn's steering
 * prompt state (see {@link BtwInjectState}), absent when the turn has none. */
export type BtwTurnDto = Omit<BtwHistoryTurn, "images"> & {
	imageCount?: number;
	inject?: BtwInjectState;
};

/** Wire shape of one saved record (see {@link BtwTurnDto}). The record's own fields are its
 * first turn; `followUps[i]` is turn `i + 1`. */
export type BtwRecordDto = Omit<BtwHistoryRecord, "images" | "followUps"> & {
	imageCount?: number;
	inject?: BtwInjectState;
	followUps?: BtwTurnDto[];
};

function toBtwTurnDto<T extends BtwHistoryTurn>(
	turn: T,
	inject: BtwInjectState | undefined,
): Omit<T, "images"> & { imageCount?: number; inject?: BtwInjectState } {
	const { images, ...rest } = turn;
	return {
		...rest,
		...(images?.length ? { imageCount: images.length } : {}),
		...(inject !== undefined ? { inject } : {}),
	};
}

function toBtwRecordDto(record: BtwHistoryRecord): BtwRecordDto {
	const { followUps, ...rest } = toBtwTurnDto(record, injectStateOf(record, 0));
	return followUps
		? {
				...rest,
				followUps: followUps.map((turn, index) =>
					toBtwTurnDto(turn, injectStateOf(record, index + 1)),
				),
			}
		: rest;
}

/** Stable cursor for record-list paging (stable ids, never list indexes). */
export interface BtwPageCursor {
	afterId?: string;
	limit?: number;
}

export interface BtwRecordPage {
	records: BtwRecordDto[];
	total: number;
	nextAfter?: string;
}

/** One transcript turn with a stable key for cursor paging. */
export interface BtwTranscriptTurn {
	key: string;
	index: number;
	question: string;
	answer: string;
	status: BtwHistoryTurn["status"];
	createdAt: number;
	updatedAt: number;
	error?: string;
	inject?: BtwInjectState;
}

export interface BtwTranscriptPage {
	turns: BtwTranscriptTurn[];
	total: number;
	nextAfter?: string;
}

/** Preview/confirm data for guarded promotion. */
export interface BtwPromotePreview {
	recordId: string;
	question: string;
	leafId: string | null;
	sessionId: string;
	eligible: boolean;
	reason?: string;
	turns: number;
}

export interface BtwPromoteResult {
	cancelled: boolean;
	sessionFile: string | undefined;
}

const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

function clampLimit(limit?: number): number {
	if (typeof limit !== "number" || !Number.isFinite(limit)) return DEFAULT_PAGE_LIMIT;
	return Math.min(Math.max(1, Math.floor(limit)), MAX_PAGE_LIMIT);
}

function pageRecords(records: readonly BtwHistoryRecord[], cursor?: BtwPageCursor): BtwRecordPage {
	const limit = clampLimit(cursor?.limit);
	const total = records.length;
	let start = 0;
	if (cursor?.afterId !== undefined) {
		const at = records.findIndex((record) => record.id === cursor.afterId);
		start = at === -1 ? total : at + 1;
	}
	const slice = records.slice(start, start + limit);
	const page: BtwRecordPage = { records: slice.map(toBtwRecordDto), total };
	if (start + slice.length < total && slice.length > 0) {
		page.nextAfter = slice[slice.length - 1]!.id;
	}
	return page;
}

function matchesQuery(record: BtwHistoryRecord, needle: string): boolean {
	const haystacks = [record.question, record.answer];
	for (const turn of record.followUps ?? []) haystacks.push(turn.question, turn.answer);
	return haystacks.some((text) => text.toLowerCase().includes(needle));
}

/** Rewrite the held ephemeral assistant message around the final reply text
 * (mirrors BtwController's assistantMessageWithReplyText): first text part is
 * replaced, thinking survives, provider replay payloads are dropped. */
function assistantMessageWithReplyText(
	assistantMessage: AssistantMessage,
	replyText: string,
): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}

interface ActiveTurn {
	abort: AbortController;
	recordId: string;
}

export interface BtwTurnOptions {
	onDelta?: (text: string) => void;
	signal?: AbortSignal;
}

/**
 * Server-owned durable BTW history for one session scope. Opened via
 * `openBtwHistory(artifactsDir, sessionId)`; scope = session id because
 * focused workers share the artifact root. Recovery (running -> interrupted)
 * stays view-only: this service only checkpoints turns it started, so a live
 * writer's lease is never stolen.
 */
export class BtwHistoryService {
	readonly #store: BtwHistoryStore;
	readonly #sessionId: string;
	/** Server-held ephemeral assistant messages, keyed by record id. Promotion
	 * resolves its payload ONLY from here; client-supplied assistant content
	 * is never accepted. */
	readonly #heldAnswers = new Map<string, AssistantMessage>();
	readonly #active = new Map<string, ActiveTurn>();
	#branchInFlight = false;
	#starting = false;

	constructor(store: BtwHistoryStore, sessionId: string) {
		this.#store = store;
		this.#sessionId = sessionId;
	}

	/** Stable id-paged record list, newest first (the store snapshot order). */
	listBtwRecords(cursor?: BtwPageCursor): BtwRecordPage {
		return pageRecords(this.#store.getRecords(), cursor);
	}

	/** Case-insensitive search across question/answer (plus follow-up turns),
	 * with the same stable id paging as the list. */
	listBtwSearch(query: string, cursor?: BtwPageCursor): BtwRecordPage {
		const needle = query.trim().toLowerCase();
		if (!needle) return this.listBtwRecords(cursor);
		return pageRecords(
			this.#store.getRecords().filter((record) => matchesQuery(record, needle)),
			cursor,
		);
	}

	findRecord(recordId: string): BtwHistoryRecord | undefined {
		return this.#store.getRecords().find((record) => record.id === recordId);
	}

	/** Cursor-paged transcript of one record's turns (root + follow-ups) with
	 * stable `<recordId>:t<index>` keys. Pure view over the mirrored record. */
	pageBtwTurns(recordId: string, afterKey?: string, limit?: number): BtwTranscriptPage {
		const record = this.findRecord(recordId);
		if (!record) throw new Error(`BTW record not found: ${recordId}`);
		const turns = getBtwTurns(record).map((turn, index): BtwTranscriptTurn => {
			const view: BtwTranscriptTurn = {
				key: `${record.id}:t${index}`,
				index,
				question: turn.question,
				answer: turn.answer,
				status: turn.status,
				createdAt: turn.createdAt,
				updatedAt: turn.updatedAt,
			};
			if (turn.error !== undefined) view.error = turn.error;
			const inject = injectStateOf(record, index);
			if (inject !== undefined) view.inject = inject;
			return view;
		});
		const capped = clampLimit(limit);
		let start = 0;
		if (afterKey !== undefined) {
			const at = turns.findIndex((turn) => turn.key === afterKey);
			start = at === -1 ? turns.length : at + 1;
		}
		const slice = turns.slice(start, start + capped);
		const page: BtwTranscriptPage = { turns: slice, total: turns.length };
		if (start + slice.length < turns.length && slice.length > 0) {
			page.nextAfter = slice[slice.length - 1]!.key;
		}
		return page;
	}

	/** Copy text for a record via the SDK rule (most recent nonblank answer,
	 * original whitespace preserved). Undefined = nothing to copy. */
	copyBtwText(recordId: string): string | undefined {
		const record = this.findRecord(recordId);
		if (!record) throw new Error(`BTW record not found: ${recordId}`);
		return getBtwCopyText(record);
	}

	/**
	 * Start a side turn via session.runEphemeralTurn (never touches the
	 * transcript). With `recordId`, appends a follow-up turn to that record
	 * (reopening its history with transport-epoch rotation); without, starts
	 * a fresh record. Deltas relay through `onDelta` (the METHODS wiring
	 * broadcasts them as ephemeral_delta frames keyed by streamId).
	 */
	async startBtwTurn(
		session: AgentSession,
		question: string,
		options: BtwTurnOptions & { recordId?: string } = {},
	): Promise<BtwRecordDto> {
		const trimmed = question.trim();
		if (!trimmed) throw new Error("BTW question must not be empty.");
		if (options.signal?.aborted) throw new Error("BTW turn aborted before it started.");
		if (this.#starting || this.#branchInFlight || this.#active.size > 0) {
			throw new Error("A /btw action is in progress. Please wait.");
		}
		const manager = session.sessionManager;
		if (manager.getSessionId() !== this.#sessionId) {
			throw new Error("BTW history scope changed; reopen history before asking.");
		}
		const previous = options.recordId !== undefined ? this.findRecord(options.recordId) : undefined;
		if (options.recordId !== undefined) {
			if (!previous) throw new Error(`BTW record not found: ${options.recordId}`);
			if (getBtwLatestTurn(previous).status === "running") {
				throw new Error("This side conversation is still running.");
			}
		}
		if (!session.model) throw new Error("No active model available for /btw.");
		const initialLeafId = manager.getLeafId();
		this.#starting = true;
		try {
			await manager.ensureOnDisk();
			if (manager.getSessionId() !== this.#sessionId || manager.getLeafId() !== initialLeafId) {
				throw new Error("The session changed while opening BTW history.");
			}
		} finally {
			this.#starting = false;
		}
		// The SDK's `#injectEnabled`, read once per question so the prompt instruction and the
		// block's sendability agree. The web asks only about the attached main session (there is
		// no focused-subagent composer), and a session process hosts its own turns (never a collab guest).
		const inject = cfgBtwInject.get(session.settings);
		const leafId = manager.getLeafId();
		const { record, history, conversationKey } = beginBtwTurn(trimmed, leafId, previous);
		const abort = new AbortController();
		const onExternalAbort = (): void => {
			abort.abort(options.signal?.reason);
		};
		options.signal?.addEventListener("abort", onExternalAbort, { once: true });
		this.#active.set(record.id, { abort, recordId: record.id });
		let partialAnswer = "";
		try {
			// Initial checkpoint owns the topic lease; a rejection here never
			// dispatched a model, so surface it directly (conflict = reopen).
			await this.#store.upsert(record);
			if (abort.signal.aborted || options.signal?.aborted) {
				await this.#settleRunning(record.id, { status: "cancelled", updatedAt: Date.now() });
				throw new Error("BTW turn aborted before it started.");
			}
			const { replyText, assistantMessage } = await runBtwTurn(session, {
				question: trimmed,
				history,
				inject,
				conversationKey,
				onTextDelta: (delta) => {
					partialAnswer += delta;
					options.onDelta?.(delta);
				},
				signal: abort.signal,
			});
			const settled = await this.#settleRunning(record.id, {
				answer: replyText,
				status: abort.signal.aborted ? "cancelled" : "complete",
				updatedAt: Date.now(),
			});
			if (settled && getBtwLatestTurn(settled).status === "complete") {
				this.#heldAnswers.set(
					record.id,
					assistantMessageWithReplyText(assistantMessage, replyText),
				);
				// Only an answer asked with the inject instruction can be sent, even if the setting is turned on later.
				if (inject && getBtwRecordInject(settled) !== undefined) {
					injects.set(getBtwTurnKey(settled), "ready");
				}
			}
			return toBtwRecordDto(settled ?? this.findRecord(record.id)!);
		} catch (error) {
			const cancelled = abort.signal.aborted || options.signal?.aborted;
			await this.#settleRunning(record.id, {
				answer: partialAnswer,
				status: cancelled ? "cancelled" : "error",
				updatedAt: Date.now(),
				...(cancelled ? {} : { error: error instanceof Error ? error.message : String(error) }),
			});
			throw cancelled ? new Error("BTW turn cancelled.") : error;
		} finally {
			options.signal?.removeEventListener("abort", onExternalAbort);
			this.#active.delete(record.id);
		}
	}

	/**
	 * Cancel a running turn: abort the ephemeral signal (running-only) and
	 * checkpoint `cancelled`. Saved turns are preserved; resolving a stopped
	 * turn is a no-op for the already-terminal record (never a conflict).
	 */
	async cancelBtwTurn(recordId: string): Promise<BtwRecordDto | undefined> {
		const record = this.findRecord(recordId);
		if (!record) throw new Error(`BTW record not found: ${recordId}`);
		if (getBtwLatestTurn(record).status !== "running") return toBtwRecordDto(record);
		const active = this.#active.get(recordId);
		if (!active) throw new Error("This BTW turn belongs to another writer; reopen history.");
		active.abort.abort();
		// The owning request checkpoints partial text after its transport settles.
		return toBtwRecordDto(record);
	}

	/**
	 * Guarded promotion preview: verified persisted/idle, unchanged
	 * identity/leaf, eligible single-turn shape. Never mutates; never moves
	 * the Main leaf.
	 */
	async previewPromoteBtw(
		session: AgentSession,
		sessionManager: SessionManager,
		recordId: string,
	): Promise<BtwPromotePreview> {
		const record = this.findRecord(recordId);
		const base = {
			recordId,
			question: record?.question ?? "",
			leafId: record?.leafId ?? null,
			sessionId: this.#sessionId,
			turns: record ? getBtwTurns(record).length : 0,
		};
		if (!record) return { ...base, eligible: false, reason: `BTW record not found: ${recordId}` };
		const fail = (reason: string): BtwPromotePreview => ({ ...base, eligible: false, reason });
		if (this.#branchInFlight) return fail("a branch is already in progress");
		if ([...injects.values()].includes("sending")) return fail("a /btw prompt is still sending");
		if (this.#starting || this.#active.size > 0) {
			return fail("a BTW action is still in progress");
		}
		// Single-turn shape only: promotion carries one Q/A pair and must not
		// drop earlier side turns.
		if ((record.followUps?.length ?? 0) > 0) {
			return fail("multi-turn side conversations remain in BTW history");
		}
		if (getBtwLatestTurn(record).status !== "complete") {
			return fail("the answer is not ready");
		}
		if (!this.#heldAnswers.has(record.id)) {
			return fail(
				"the original server-held answer is unavailable after restart; saved text remains readable",
			);
		}
		if (record.leafId === null) {
			return fail("the session has no branch point");
		}
		if (
			sessionManager.getSessionId() !== this.#sessionId ||
			sessionManager.getLeafId() !== record.leafId
		) {
			return fail("the session changed since /btw started");
		}
		if (session.isBusyForSnapshot) {
			return fail("a turn is still running");
		}
		if (!sessionManager.getSessionFile()) {
			return fail("session is not persisted");
		}
		// Flush-before-promote: a stuck history write blocks the lifecycle move.
		try {
			await this.#store.flush();
		} catch (error) {
			return fail(`BTW history could not be saved: ${toError(error).message}`);
		}
		if (
			sessionManager.getSessionId() !== this.#sessionId ||
			sessionManager.getLeafId() !== record.leafId
		) {
			return fail("the session changed since /btw started");
		}
		if (session.isBusyForSnapshot) return fail("a turn is still running");
		return { ...base, eligible: true };
	}

	/**
	 * Server-owned promotion: calls ONLY
	 * `session.branchFromBtw(question, assistantMessage, leafId, sessionId)`
	 * with the server-held ephemeral assistant message, after verifying
	 * persisted (store.flush ok), idle (not streaming), unchanged
	 * identity/leaf pre AND post hooks, and the eligible single-turn shape.
	 * The record's own images (saved by the TUI) ride along so the branch
	 * holds the Q/A pair verbatim. The Main leaf is unchanged until
	 * success; the new sessionFile arrives in the result for the caller to
	 * adopt through the normal switch flow.
	 */
	async promoteBtwToBranch(
		session: AgentSession,
		sessionManager: SessionManager,
		recordId: string,
	): Promise<BtwPromoteResult> {
		const preview = await this.previewPromoteBtw(session, sessionManager, recordId);
		if (!preview.eligible) {
			throw new Error(`Cannot branch /btw: ${preview.reason ?? "the answer is not ready"}`);
		}
		if (this.#branchInFlight || this.#starting || this.#active.size > 0) {
			throw new Error("Cannot branch /btw: another BTW action is in progress.");
		}
		const record = this.findRecord(recordId)!;
		const assistantMessage = this.#heldAnswers.get(recordId);
		if (!assistantMessage || !record.leafId) {
			throw new Error("Cannot branch /btw: the answer is unavailable");
		}
		// Pre-hook identity gate (branchFromBtw re-checks; this is the
		// adapter's own unchanged-identity verification before the move).
		if (
			sessionManager.getSessionId() !== this.#sessionId ||
			sessionManager.getLeafId() !== record.leafId
		) {
			throw new Error("Cannot branch /btw: session changed since /btw started");
		}
		this.#branchInFlight = true;
		try {
			const { cancelled, sessionFile } = await session.branchFromBtw(
				record.question,
				assistantMessage,
				record.leafId,
				this.#sessionId,
				record.images?.length ? [...record.images] : undefined,
			);
			// branchFromBtw performs pre/post-hook identity and idle gates itself.
			// A successful promotion intentionally rotates the session identity;
			// comparing it with the source here would reject every successful branch.
			return { cancelled, sessionFile };
		} finally {
			this.#branchInFlight = false;
		}
	}

	/**
	 * Send a record's steering prompt (its latest turn's closed `<inject>` block) to the main
	 * session as a user message: a steer while the agent runs, else a new turn. Mirrors the SDK
	 * controller's `#inject`. Slash commands and templates are not expanded, so model-written
	 * text never runs as a command. The turn counts as sent once the session admits it; a
	 * send dropped or refused before it reached the transcript or the steer queue throws and
	 * leaves the turn pending, so the same call is its one retry path. A failure after admission
	 * goes to `onLateError` and keeps the turn sent, so it is never sent twice. Only a turn
	 * answered in this process with the inject instruction can send, and only once.
	 */
	async injectBtw(
		session: AgentSession,
		recordId: string,
		options: { onLateError?: (error: unknown) => void } = {},
	): Promise<BtwRecordDto> {
		const record = this.findRecord(recordId);
		if (!record) throw new Error(`BTW record not found: ${recordId}`);
		const text = getBtwRecordInject(record);
		const key = getBtwTurnKey(record);
		const state = injects.get(key);
		if (text === undefined || state === undefined) {
			throw new Error("This answer has no steering prompt to send.");
		}
		if (state === "sent")
			throw new Error("This steering prompt was already sent to the main session.");
		if (state === "sending") throw new Error("This steering prompt is still sending.");
		if (this.#starting || this.#branchInFlight) {
			throw new Error("A /btw action is in progress. Please wait.");
		}
		injects.set(key, "sending");
		try {
			// `prompt()` would wait for startup-deferred extensions before its own session-switch
			// checks run, so a `/new` in that wait could land this prompt in the new session. Wait
			// here instead and drop the send if the session moved.
			if (session.hasPendingDeferredExtensions) {
				await session.loadDeferredExtensions();
				if (session.sessionManager.getSessionId() !== this.#sessionId) {
					throw new Error("The session changed before the prompt was sent.");
				}
			}
			await this.#sendInject(session, key, text, options.onLateError);
		} catch (error) {
			// Nothing reached the transcript or the steer queue: back to pending for a retry.
			if (injects.get(key) === "sending") injects.set(key, "ready");
			throw toError(error);
		}
		return toBtwRecordDto(this.findRecord(recordId) ?? record);
	}

	/** Resolves once the session admits `text`; rejects when it was dropped or refused before admission. */
	#sendInject(
		session: AgentSession,
		key: string,
		text: string,
		onLateError: ((error: unknown) => void) | undefined,
	): Promise<void> {
		const lastUserMessage = () => session.messages.findLast((message) => message.role === "user");
		const userBefore = lastUserMessage();
		const outcome = Promise.withResolvers<void>();
		let admitted = false;
		let queued = false;
		session
			.prompt(text, {
				expandPromptTemplates: false,
				streamingBehavior: "steer",
				throwOnDrop: true,
				onPromptQueued: () => {
					queued = true;
				},
				onPromptAdmitted: () => {
					admitted = true;
					injects.set(key, "sent");
					outcome.resolve();
				},
			})
			.then(
				() => {
					// A drop while queueing resolves without admission: nothing was sent.
					if (!admitted) outcome.reject(new Error("The steering prompt was not sent."));
				},
				(error: unknown) => {
					if (admitted) {
						onLateError?.(error);
						return;
					}
					// Already in the steer queue or the transcript: it was sent, so keep the mark.
					if (queued || lastUserMessage() !== userBefore) {
						injects.set(key, "sent");
						onLateError?.(error);
						outcome.resolve();
						return;
					}
					outcome.reject(toError(error));
				},
			);
		return outcome.promise;
	}

	/**
	 * Checkpoint the latest turn of `recordId` only when it is still running
	 * (view-only recovery rule: an already-terminal record — cancelled by a
	 * racing cancel, or interrupted at open — is never rewritten, so a live
	 * writer's lease is never stolen and no CAS conflict is raised).
	 */
	async #settleRunning(
		recordId: string,
		patch: Partial<BtwHistoryTurn>,
	): Promise<BtwHistoryRecord | undefined> {
		const current = this.findRecord(recordId);
		if (!current || getBtwLatestTurn(current).status !== "running") return current;
		await this.#store.upsert(patchLatestBtwTurn(current, patch));
		return this.findRecord(recordId);
	}
}

/**
 * Open the durable BTW history for an artifacts directory, scoped by session
 * id (workers share the artifact root). Recovery maps running -> interrupted
 * as a view; only turns this service starts are ever checkpointed back.
 */
async function openBtwHistory(
	artifactsDir: string | undefined,
	sessionId: string,
): Promise<BtwHistoryService> {
	if (!artifactsDir)
		throw new Error("Durable BTW history requires a persisted artifacts directory.");
	const store = await BtwHistoryStore.open(artifactsDir, sessionId);
	return new BtwHistoryService(store, sessionId);
}

/** Per-session service cache for the METHODS wiring (one session process owns
 * many sessions over its lifetime; each scope keeps its own store/leases).
 * Stale on session-id rotation: the entry is reopened when the live manager's
 * session id no longer matches the cached scope. */
const services = new WeakMap<
	AgentSession,
	{ sessionId: string; service: Promise<BtwHistoryService> }
>();

export async function serviceFor(session: AgentSession): Promise<BtwHistoryService> {
	const liveId = session.sessionManager.getSessionId();
	const cached = services.get(session);
	if (cached && cached.sessionId === liveId) return cached.service;
	const service = (async () => {
		await session.sessionManager.ensureOnDisk();
		if (session.sessionManager.getSessionId() !== liveId) {
			throw new Error("The session changed while opening BTW history.");
		}
		return openBtwHistory(session.sessionManager.getArtifactsDir() ?? undefined, liveId);
	})();
	const entry = { sessionId: liveId, service };
	services.set(session, entry);
	try {
		return await service;
	} catch (error) {
		if (services.get(session) === entry) services.delete(session);
		throw error;
	}
}
