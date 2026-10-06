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
// WIRING NOTE (for the integrator / P0): this module owns no transport. Each
// server method below maps 1:1 onto a PROPOSED additive wire method
// (OMP_PROTO stays 2; see the PROPOSED WIRE DTOs block at the bottom). P0
// publishes the canonical names/shapes into protocol.ts and adds one row per
// method to the METHODS dispatch in apps/session/methods.ts delegating to
// `serviceFor(entry.session)`; no other server file changes are needed. The
// web mirror lives in apps/web/store/btw-history.ts; the fleet discovery
// helper lives in apps/fleet/btw-lineage.ts.
//
// Secrets/tokens never appear in DTOs/logs here. stdout stays reserved for
// OMP_SESSION| lines; log via stderr only.

import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	BtwHistoryStore,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
	type BtwHistoryRecord,
	type BtwHistoryTurn,
} from "@oh-my-pi/pi-coding-agent/session/btw-history";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, prompt, toError } from "@oh-my-pi/pi-utils";

// The SDK's btw-user prompt body (mirrors the file the BtwController
// renders): the packaged SDK ships no dist prompt text module, so the body
// is inlined here and revalidated against the installed SDK source in the
// C01 ledger. Any render failure falls back to the raw question; both paths
// stay ephemeral side context, never transcript.
const BTW_USER_PROMPT = `<btw>
Ephemeral side question for current interactive session.
Answer briefly, directly; use conversation context already provided.
NEVER use tools.
NEVER ask follow-up questions.
Question:
{{question}}
</btw>`;

function renderBtwPrompt(question: string): string {
	try {
		return prompt.render(BTW_USER_PROMPT, { question });
	} catch {
		return question;
	}
}

/** Stable cursor for record-list paging (stable ids, never list indexes). */
export interface BtwPageCursor {
	afterId?: string;
	limit?: number;
}

export interface BtwRecordPage {
	records: BtwHistoryRecord[];
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
	const page: BtwRecordPage = { records: [...slice], total };
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

/** Zero-usage side context for a follow-up turn (mirrors BtwController's
 * history build): saved BTW text re-enters as context messages, never as new
 * billed turns, and never touches the transcript. */
function buildFollowUpHistory(turns: readonly BtwHistoryTurn[], model: Model): Message[] {
	const history: Message[] = [];
	for (const turn of turns) {
		history.push({
			role: "user",
			content: [{ type: "text", text: renderBtwPrompt(turn.question) }],
			attribution: "agent",
			timestamp: turn.createdAt,
		});
		if (!turn.answer) continue;
		history.push({
			role: "assistant",
			content: [{ type: "text", text: turn.answer }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: turn.updatedAt,
		});
	}
	return history;
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
	#transitionCount = 0;

	constructor(store: BtwHistoryStore, sessionId: string) {
		this.#store = store;
		this.#sessionId = sessionId;
	}

	/** Scope key this service was opened for (the owning session id). */
	get scopeSessionId(): string {
		return this.#sessionId;
	}

	get store(): BtwHistoryStore {
		return this.#store;
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
	): Promise<BtwHistoryRecord> {
		const trimmed = question.trim();
		if (!trimmed) throw new Error("BTW question must not be empty.");
		if (options.signal?.aborted) throw new Error("BTW turn aborted before it started.");
		if (
			this.#starting ||
			this.#branchInFlight ||
			this.#transitionCount > 0 ||
			this.#active.size > 0
		) {
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
		const model = session.model;
		if (!model) throw new Error("No active model available for /btw.");
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
		const leafId = manager.getLeafId();
		const now = Date.now();
		const turn: BtwHistoryTurn = {
			question: trimmed,
			answer: "",
			status: "running",
			createdAt: now,
			updatedAt: now,
		};
		const record: BtwHistoryRecord = previous
			? { ...previous, followUps: [...(previous.followUps ?? []), turn] }
			: { ...turn, id: Snowflake.next(), leafId };
		const history = previous ? getBtwTurns(previous) : undefined;
		// A cancelled/failed transport may still be unwinding. Start a fresh
		// lineage after that boundary, while successful follow-ups share one.
		let lastNonComplete = -1;
		if (history) {
			for (let index = 0; index < history.length; index++) {
				if (history[index]!.status !== "complete") lastNonComplete = index;
			}
		}
		const conversationKey = `btw:${record.id}:${lastNonComplete + 1}`;
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
			const { replyText, assistantMessage } = await session.runEphemeralTurn({
				promptText: renderBtwPrompt(trimmed),
				history: history ? buildFollowUpHistory(history, model) : undefined,
				conversationKey,
				// Answers are read in full and saved: keep the repeated-line
				// collapse, not the 4 KiB cap meant for one-liners.
				replyMaxBytes: Number.POSITIVE_INFINITY,
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
			}
			return settled ?? this.findRecord(record.id)!;
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

	/** Follow-up appends a turn to an existing record (same epoch-rotation
	 * and lease rules as a fresh start). */
	followUpBtw(
		session: AgentSession,
		recordId: string,
		question: string,
		options: BtwTurnOptions = {},
	): Promise<BtwHistoryRecord> {
		return this.startBtwTurn(session, question, { ...options, recordId });
	}

	/**
	 * Cancel a running turn: abort the ephemeral signal (running-only) and
	 * checkpoint `cancelled`. Saved turns are preserved; resolving a stopped
	 * turn is a no-op for the already-terminal record (never a conflict).
	 */
	async cancelBtwTurn(recordId: string): Promise<BtwHistoryRecord | undefined> {
		const record = this.findRecord(recordId);
		if (!record) throw new Error(`BTW record not found: ${recordId}`);
		if (getBtwLatestTurn(record).status !== "running") return record;
		const active = this.#active.get(recordId);
		if (!active) throw new Error("This BTW turn belongs to another writer; reopen history.");
		active.abort.abort();
		// The owning request checkpoints partial text after its transport settles.
		return record;
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
		if (this.#starting || this.#transitionCount > 0 || this.#active.size > 0) {
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
	 * BTW records carry text only, so there are no attachments to carry (the
	 * branch holds the Q/A pair verbatim). The Main leaf is unchanged until
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
		if (
			this.#branchInFlight ||
			this.#starting ||
			this.#transitionCount > 0 ||
			this.#active.size > 0
		) {
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
			);
			// branchFromBtw performs pre/post-hook identity and idle gates itself.
			// A successful promotion intentionally rotates the session identity;
			// comparing it with the source here would reject every successful branch.
			return { cancelled, sessionFile };
		} finally {
			this.#branchInFlight = false;
		}
	}

	async flush(): Promise<void> {
		await this.#store.flush();
	}

	/**
	 * Flush-before-lifecycle-move (mirrors BtwController.withSessionMove):
	 * refuses the move while a turn streams or a branch is in flight, drains
	 * pending history writes first, and runs the move only when the store is
	 * durable. Never steals a live writer's lease.
	 */
	async withSessionMove(operation: () => Promise<boolean>): Promise<boolean> {
		if (this.#starting || this.#active.size > 0) {
			throw new Error("Wait for the current /btw answer to settle before moving.");
		}
		if (this.#branchInFlight) {
			throw new Error("/btw branch is in progress.");
		}
		this.#transitionCount++;
		try {
			await this.#store.flush();
			return await operation();
		} finally {
			this.#transitionCount--;
		}
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
		const followUps = current.followUps;
		const next: BtwHistoryRecord = followUps?.length
			? {
					...current,
					followUps: [...followUps.slice(0, -1), { ...followUps[followUps.length - 1]!, ...patch }],
				}
			: { ...current, ...patch };
		await this.#store.upsert(next);
		return this.findRecord(recordId);
	}
}

/**
 * Open the durable BTW history for an artifacts directory, scoped by session
 * id (workers share the artifact root). Recovery maps running -> interrupted
 * as a view; only turns this service starts are ever checkpointed back.
 */
export async function openBtwHistory(
	artifactsDir: string | undefined,
	sessionId: string,
): Promise<BtwHistoryService> {
	if (!artifactsDir)
		throw new Error("Durable BTW history requires a persisted artifacts directory.");
	const store = await BtwHistoryStore.open(artifactsDir, sessionId);
	return new BtwHistoryService(store, sessionId);
}

/** Per-session service cache for the METHODS wiring (one daemon process owns
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

// ---------------------------------------------------------------------------
// PROPOSED WIRE DTOs (for P0; OMP_PROTO stays 2, additive-only). Each call
// site casts its name `as WebMethodName` with a P0-TODO comment. All methods
// are Capability-gated: pre-P0 servers reject with unknown-method and the web
// mirror reports {available:false} instead of failing. Stable ids + cursor
// paging throughout; never list indexes, message text, or filenames as
// identity. Side-turn deltas reuse the existing ephemeral_delta SSE frames
// (streamId = the call's streamId); answers settle via call_result with the
// standard duplicate-command-result replay.
//   btwCapabilities {} -> { available: boolean, reason?: string }
//     reason: server-advertised gate for the whole slice (replaces
//       unknown-method sniffing once published).
//   btwList { afterId?: string, limit?: number } -> BtwRecordPage
//     reason: durable-history list for the attached session scope.
//   btwSearch { query: string, afterId?: string, limit?: number } -> BtwRecordPage
//     reason: search across question/answer (incl. follow-ups).
//   btwPage { recordId: string, afterKey?: string, limit?: number } -> BtwTranscriptPage
//     reason: paged transcript of one record (stable turn keys).
//   btwStart { question: string } -> { record: BtwHistoryRecord }
//     reason: fresh side turn (deltas stream as ephemeral_delta).
//   btwFollowUp { recordId: string, question: string } -> { record: BtwHistoryRecord }
//     reason: append a follow-up turn (epoch-rotated conversationKey).
//   btwCancel { recordId: string } -> { record: BtwHistoryRecord }
//     reason: running-only abort; saved turns survive.
//   btwCopy { recordId: string } -> { text?: string }
//     reason: server-resolved copy text (absent = nothing to copy).
//   btwPromotePreview { recordId: string } -> BtwPromotePreview
//     reason: guarded-promotion eligibility without mutation.
//   btwPromote { recordId: string } -> BtwPromoteResult
//     reason: server-owned branchFromBtw; client never supplies the assistant
//       payload (only the recordId; the assistant message is server-held).
//
// PROPOSED METHODS DISPATCH (apps/session/methods.ts, one row each; entry =
// SessionEntry, streamId routes deltas via broadcastTo ephemeral_delta):
//   btwList: async (entry, a) => (await serviceFor(entry.session)).listBtwRecords(a[0] as BtwPageCursor|undefined)
//   btwSearch: async (entry, a) => (await serviceFor(entry.session)).listBtwSearch(
//     String(a[0] ?? ""), a[1] as BtwPageCursor|undefined)
//   btwPage: async (entry, a) => (await serviceFor(entry.session)).pageBtwTurns(
//     String(a[0]), a[1] as string|undefined, a[2] as number|undefined)
//   btwStart/btwFollowUp: async (entry, a, streamId) => {
//     const service = await serviceFor(entry.session);
//     const record = await service.startBtwTurn(entry.session, String(a[0] ?? ""), {
//       ...(a[1] !== undefined ? { recordId: String(a[1]) } : {}),
//       onDelta: (text) => { if (streamId !== undefined)
//         broadcastTo(entry.handle, { type: "ephemeral_delta", id: streamId, text }); },
//     });
//     return { record };
//   }
//   btwCancel: async (entry, a) => ({ record: await (await serviceFor(entry.session)).cancelBtwTurn(String(a[0])) })
//   btwCopy: async (entry, a) => ({ text: (await serviceFor(entry.session)).copyBtwText(String(a[0])) ?? null })
//   btwPromotePreview: async (entry, a) => (await serviceFor(entry.session)).previewPromoteBtw(
//     entry.session, entry.session.sessionManager, String(a[0]))
//   btwPromote: async (entry, a) => (await serviceFor(entry.session)).promoteBtwToBranch(
//     entry.session, entry.session.sessionManager, String(a[0]))
//   btwCapabilities: async () => ({ available: true })
// readOnly: btwList, btwSearch, btwPage, btwCopy, btwPromotePreview (never
//   mutate); notReadyGated: btwStart, btwFollowUp (need a live model).
// ---------------------------------------------------------------------------
