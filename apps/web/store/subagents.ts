import { batch, createSignal, untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { SubagentImageResult, SubagentMessagesResult } from "#lib/wire/protocol";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { isBackgroundRunning } from "../chat/background-job";
import { createHistoryBuilder, type HistoryBuilder } from "../chat/history-items";
import { metricsOf, normalizeStatus, type UsageFallback } from "./subagent-frames";
import { call } from "./transport";
import { pushNotice } from "./chat";
import { setState, setView, state, type ChatItem, type SubagentInfo } from "../state";
import { api } from "./fleet-api";
import { subagentAnalysisHash } from "./slices/analysis";
import { agentTitle, shortAgentName, sumKnown } from "../subagents/format";
import { isActiveSubagent } from "../subagents/tree";
import { imageBlobHash } from "../text/images";
import {
	liveLineOf,
	modelView,
	pickProgress,
	type SubagentLiveLine,
	type SubagentModelView,
} from "../subagents/progress";

/**
 * Subagents domain (Phase 3 store facade split). The subagent mirror itself
 * (state.subagents) is maintained by the connect() mux in state.ts; this
 * module owns the mid-task steering/abort actions.
 *
 * All worker/advisor/goal/vibe reads go through `call()` (in-band command id
 * dedup + call_result frame + ring replay). No new transport.
 */

/** Steer a running subagent mid-task; rejects for unknown/idle/parked agents. */
export function steerSubagent(agentId: string, text: string): Promise<unknown> {
	return call("subagentSteer", [agentId, text]);
}

/** Abort one running subagent; Main and siblings are unaffected. */
export function abortSubagent(agentId: string): Promise<unknown> {
	return call("subagentAbort", [agentId]);
}

// ---------------------------------------------------------------------------
// Tolerant payload coercion. Server payloads are untrusted: wrong shapes yield
// defaults, never throws. The field readers below are shared by every DTO
// coercer (20+ call sites) so missing/wrong-typed fields degrade alike.
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Worker roster. Server DTO read models.
// ---------------------------------------------------------------------------

export type WorkerStatus =
	| "pending"
	| "started"
	| "running"
	| "idle"
	| "parked"
	| "completed"
	| "failed"
	| "aborted"
	| "unavailable";

export interface WorkerRecord {
	id: string;
	agentId: string;
	sessionId: string;
	key: string;
	displayName: string;
	status: WorkerStatus;
	parentAgentId?: string;
	parentToolCallId?: string;
	kind?: string;
	task?: string;
	assignment?: string;
	description?: string;
	model?: string;
	progress?: Record<string, unknown>;
	usage?: {
		tokens?: number;
		requests: number;
		cost?: number;
		contextTokens?: number;
		contextWindow?: number;
	};
	artifactAvailability: "available" | "missing" | "unknown";
	sessionFile: string | null;
	hasHistory: boolean;
	lastActivity: number;
	createdAt: number;
	adopted: boolean;
	revivable: boolean;
}

/** True for terminal worker states (completed/failed/aborted). */
export function isTerminalWorker(s: string): boolean {
	return s === "completed" || s === "failed" || s === "aborted";
}

/** READ-ONLY worker: advisor kind, terminal status, or unavailable/missing history. */
export function isReadOnlyWorker(r: Pick<WorkerRecord, "status"> & { kind?: string }): boolean {
	if (isTerminalWorker(r.status)) return true;
	if (r.status === "unavailable") return true;
	if (typeof r.kind === "string" && r.kind.toLowerCase() === "advisor") return true;
	if ("hasHistory" in r && r.hasHistory === false) return true;
	return false;
}

function coerceWorkerStatus(value: unknown): WorkerStatus {
	switch (value) {
		case "pending":
		case "started":
		case "running":
		case "idle":
		case "parked":
		case "completed":
		case "failed":
		case "aborted":
		case "unavailable":
			return value;
		default:
			return "unavailable";
	}
}

/** Usage the session retained for a finished worker; undefined when it reported none. */
function coerceRosterUsage(value: unknown): WorkerRecord["usage"] {
	const usage = asRecord(value);
	if (!usage) return undefined;
	return {
		tokens: asNumber(usage.tokens),
		requests: asNumber(usage.requests) ?? 0,
		cost: asNumber(usage.cost),
	};
}

function coerceWorkerRow(row: unknown, sessionId: string): WorkerRecord | null {
	const r = asRecord(row);
	if (!r) return null;
	const id = asString(r.agentId) ?? asString(r.id);
	if (!id) return null;
	const progress = asRecord(r.progress) ?? undefined;
	const sessionFile = asString(r.sessionFile) ?? null;
	return {
		id,
		agentId: id,
		sessionId,
		key: workerKey(sessionId, id),
		displayName: asString(r.displayName) ?? asString(r.agent) ?? id,
		status: coerceWorkerStatus(r.status ?? progress?.status),
		parentAgentId: asString(r.parentAgentId),
		parentToolCallId: asString(r.parentToolCallId),
		kind: asString(r.kind),
		task: asString(r.task) ?? asString(progress?.task),
		assignment: asString(r.assignment) ?? asString(progress?.assignment),
		description: asString(r.description) ?? asString(progress?.description),
		model: asString(r.model) ?? asString(progress?.resolvedModel),
		progress,
		usage: progress
			? {
					tokens: asNumber(progress.tokens),
					requests: asNumber(progress.requests) ?? 0,
					cost: asNumber(progress.cost),
					contextTokens: asNumber(progress.contextTokens),
					contextWindow: asNumber(progress.contextWindow),
				}
			: coerceRosterUsage(r.usage),
		artifactAvailability:
			r.hasHistory === false ? "missing" : r.hasHistory === true ? "available" : "unknown",
		sessionFile,
		hasHistory: asBoolean(r.hasHistory) ?? sessionFile !== null,
		lastActivity: asNumber(r.lastActivity) ?? asNumber(r.lastUpdate) ?? 0,
		createdAt: asNumber(r.createdAt) ?? 0,
		adopted: asBoolean(r.adopted) ?? false,
		revivable: asBoolean(r.revivable) ?? false,
	};
}

/** Failures reject: an unavailable roster must not look like an empty success. */
export async function listWorkers(): Promise<WorkerRecord[]> {
	const sessionId = state.currentWorkspaceId;
	if (!sessionId) throw new Error("No session attached");
	const data = await call("workerList", []);
	const field = asRecord(data)?.workers;
	const list = Array.isArray(data) ? data : Array.isArray(field) ? field : null;
	if (!list) throw new Error("Invalid worker roster");
	if (state.currentWorkspaceId !== sessionId)
		throw new Error("Session switched during worker discovery");
	setState("workers", (previous) => normalizeWorkerSnapshot(previous, sessionId, list));
	setState("subagentsLoaded", "roster", true);
	return list
		.map((row) => coerceWorkerRow(row, sessionId))
		.filter((row): row is WorkerRecord => row !== null);
}

/** Park a worker; rejects (throws to caller) on server failure. */
export function parkWorker(
	agentId: string,
): Promise<{ id: string; status: string; parked: boolean }> {
	return call("workerPark", [agentId]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return {
			id: asString(r.id) ?? agentId,
			status: asString(r.status) ?? "",
			parked: asBoolean(r.parked) ?? false,
		};
	});
}

/** Revive a parked or stopped worker; rejects (throws to caller) on server failure. */
export function reviveWorker(agentId: string): Promise<{ id: string; status: string }> {
	return call("workerRevive", [agentId]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { id: asString(r.id) ?? agentId, status: asString(r.status) ?? "" };
	});
}

// ---------------------------------------------------------------------------
// Component-layer glue: transient presentation helpers for the Activities panel.
// Durable agent state stays server-side; this module never writes the
// state.subagents mirror (the connect() mux owns it).
// ---------------------------------------------------------------------------

/** One-shot snapshot of the live subagent mirror (reactive hubs read state.subagents directly). */
export function readSubagentMirror(): SubagentInfo[] {
	return [...state.subagents.values()];
}

/**
 * Surface a mutating-call rejection in chat plus the error banner. Mutating
 * calls throw to the caller (never swallowed here); components call this — or
 * their own sink — when handling the rejection.
 */
export function noticeCallError(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	pushNotice("error", message);
	setState("error", message);
}

export interface WorkersState {
	records: Record<string, WorkerRecord>;
	order: string[];
}

export function createWorkersState(): WorkersState {
	return { records: {}, order: [] };
}

/** Tuple encoding avoids collisions between session and worker IDs. */
export function workerKey(sessionId: string, agentId: string): string {
	return JSON.stringify([sessionId, agentId]);
}

/**
 * Sessions dir (fleet health) that Analysis paths are relative to. Loaded
 * once, on first need; Analysis links stay hidden until it is known.
 */
const [analysisSessionsDir, setAnalysisSessionsDir] = createSignal<string | null>(null);
let sessionsDirLoading = false;

/** Load the sessions dir (idempotent). Call only while Analysis is enabled. */
export function ensureAnalysisSessionsDir(): void {
	if (analysisSessionsDir() !== null || sessionsDirLoading) return;
	sessionsDirLoading = true;
	api.health().then(
		(h) => setAnalysisSessionsDir(h.sessionsDir),
		() => {
			sessionsDirLoading = false;
		},
	);
}

/**
 * Analysis hash that opens one agent's transcript inside the attached
 * session, or null when the "Open in Analysis" action must be hidden.
 */
export function subagentAnalysisHref(id: string, analysisEnabled: boolean): string | null {
	const record = state.workers.records[workerKey(state.currentWorkspaceId, id)];
	return subagentAnalysisHash({
		analysisEnabled,
		sessionsDir: analysisSessionsDir(),
		parentFile: state.sessionFile,
		subagentFile: record?.sessionFile,
	});
}

/** Switch to Analysis and point its hash at `hash` (from `subagentAnalysisHref`). */
export function openAnalysisHash(hash: string): void {
	setView("analysis");
	window.location.hash = hash;
}

/** Snapshots rediscover workers without deleting retained terminal history or unread activity. */
export function normalizeWorkerSnapshot(
	previous: WorkersState,
	sessionId: string,
	rows: unknown[],
): WorkersState {
	const records = { ...previous.records };
	const order = [...previous.order];
	for (const row of rows) {
		const record = coerceWorkerRow(row, sessionId);
		if (!record) continue;
		const old = records[record.key];
		if (!old) order.push(record.key);
		// Progress and the usage derived from it are a live sample (the first roster read after a spawn can
		// carry one taken 45 ms in). Keep them only while the worker runs; once it settles the row's own
		// usage (retained at finish, or summed from its transcript) is the truth, and absent means unknown.
		const running =
			record.status === "pending" || record.status === "started" || record.status === "running";
		records[record.key] = {
			...old,
			...record,
			progress: record.progress ?? (running ? old?.progress : undefined),
			usage: record.usage ?? (running ? old?.usage : undefined),
			parentAgentId: record.parentAgentId ?? old?.parentAgentId,
		};
	}
	return { ...previous, records, order };
}

export type WorkerInfo = SubagentInfo & Partial<WorkerRecord>;

export function getWorkerInfo(
	sessionId: string,
	agentId: string,
): WorkerInfo | SubagentInfo | null {
	const record = state.workers.records[workerKey(sessionId, agentId)];
	const live = sessionId === state.currentWorkspaceId ? state.subagents.get(agentId) : undefined;
	if (!record) return live ?? null;
	const base: SubagentInfo = live ?? {
		id: agentId,
		index: 0,
		agent: record.displayName,
		status: record.status,
		lastUpdate: record.lastActivity,
	};
	return {
		...base,
		...record,
		index: live?.index ?? 0,
		agent: live?.agent ?? record.displayName,
		lastUpdate: record.lastActivity,
		progress: record.progress,
	};
}

export function getSessionWorkerInfos(sessionId: string): Array<WorkerInfo | SubagentInfo> {
	const ids = new Set(
		state.workers.order
			.map((key) => state.workers.records[key])
			.filter((record) => record.sessionId === sessionId)
			.map((record) => record.agentId),
	);
	if (sessionId === state.currentWorkspaceId) for (const id of state.subagents.keys()) ids.add(id);
	return [...ids].flatMap((id) => {
		const info = getWorkerInfo(sessionId, id);
		return info ? [info] : [];
	});
}

export type SubagentStatus = "pending" | "running" | "done" | "failed" | "aborted" | "parked";

export interface SubagentMetrics {
	elapsedMs: number;
	contextPercent?: number;
	/** input + output + cacheWrite, like the TUI. Undefined when never reported: render "-", never 0. */
	tokens?: number;
	cost?: number;
}

export interface SubagentNode {
	id: string;
	parentId?: string;
	toolCallId?: string;
	/** Short name: last dot segment of the id, `-N` dedup suffix kept. */
	name: string;
	/** description, else first non-empty assignment line, else displayName. */
	title: string;
	agentType?: string;
	status: SubagentStatus;
	startedAt?: number;
	endedAt?: number;
	metrics: SubagentMetrics;
	/** Self plus descendants. Never context percent. */
	subtree: { tokens?: number; cost?: number };
	/** Model from live progress only; undefined when unknown (e.g. parked). */
	model?: SubagentModelView;
	/** The running agent's live tool line; undefined unless running. */
	live?: SubagentLiveLine;
	/** The running agent's self-estimated completion, 0-100; undefined unless running and estimated. Its stage rides in `live.stage`. */
	completionPercent?: number;
	children: SubagentNode[];
}

export interface SubagentCapabilities {
	steer: boolean;
	abort: boolean;
	park: boolean;
	revive: boolean;
}

export interface SubagentTranscriptView {
	/** Built chat items; appended in place, results patch their ToolItem in place. */
	readonly items: readonly ChatItem[];
	/** True until the first catch-up from byte 0 finishes. */
	readonly loading: boolean;
	readonly error: string | null;
}

const ROSTER_RETRY_MS = [0, 500, 1500, 4000];
let rosterGeneration = 0;

/** A newer request supersedes pending retries by bumping the generation; stale callbacks return early. */
function scheduleRoster(attempt: number, generation: number): void {
	setTimeout(() => {
		if (generation !== rosterGeneration) return;
		listWorkers().catch(() => {
			if (attempt + 1 < ROSTER_RETRY_MS.length) scheduleRoster(attempt + 1, generation);
		});
	}, ROSTER_RETRY_MS[attempt]);
}

/** Coalesced roster refetch on lifecycle edges (SUB-10). Retries with backoff while the session is unreachable. */
export function requestRosterRefresh(): void {
	rosterGeneration += 1;
	scheduleRoster(0, rosterGeneration);
}

function rosterOfSession(): WorkerRecord[] {
	const sessionId = state.currentWorkspaceId;
	return state.workers.order
		.map((key) => state.workers.records[key])
		.filter(
			(record): record is WorkerRecord => record !== undefined && record.sessionId === sessionId,
		);
}

function resolveStatus(
	live: SubagentInfo | undefined,
	record: WorkerRecord | undefined,
): SubagentStatus {
	if (!live) return normalizeStatus(record?.status);
	// Live wins (SUB-04), except a newer roster park: park does not emit a lifecycle frame.
	if (record?.status === "parked" && record.lastActivity > live.lastUpdate) return "parked";
	return normalizeStatus(live.status);
}

function sumSubtree(node: SubagentNode, visited: Set<string>): { tokens?: number; cost?: number } {
	const tokens = [node.metrics.tokens];
	const cost = [node.metrics.cost];
	if (!visited.has(node.id)) {
		visited.add(node.id);
		for (const child of node.children) {
			const sum = sumSubtree(child, visited);
			tokens.push(sum.tokens);
			cost.push(sum.cost);
		}
	}
	node.subtree = { tokens: sumKnown(tokens), cost: sumKnown(cost) };
	return node.subtree;
}

function buildForest(): SubagentNode[] {
	const now = Date.now();
	const records = new Map(rosterOfSession().map((record) => [record.agentId, record] as const));
	const nodes = new Map<string, SubagentNode>();
	const infos = new Map<string, { info: SubagentInfo; record: WorkerRecord | undefined }>();
	for (const [id, info] of state.subagents) infos.set(id, { info, record: records.get(id) });
	for (const [id, record] of records) {
		if (infos.has(id)) continue;
		const info: SubagentInfo = {
			id,
			index: -1,
			agent: record.displayName,
			status: record.status,
			lastUpdate: record.lastActivity,
			startedAt: record.createdAt,
			parentToolCallId: record.parentToolCallId,
			progress: record.progress,
			// Parked is not running: its clock stops at the last activity, like a terminal row.
			endedAt:
				isTerminalWorker(record.status) || record.status === "parked"
					? record.lastActivity
					: undefined,
		};
		infos.set(id, { info, record });
	}
	for (const [id, { info, record }] of infos) {
		const fallback: UsageFallback | undefined = record?.usage;
		const status = resolveStatus(state.subagents.get(id), record);
		const progress = pickProgress(info.progress);
		nodes.set(id, {
			id,
			parentId: record?.parentAgentId,
			toolCallId: info.parentToolCallId ?? record?.parentToolCallId,
			name: shortAgentName(id),
			title: agentTitle({
				description: info.description ?? record?.description,
				assignments: [record?.assignment, record?.task ?? info.task],
				displayName: record?.displayName ?? info.agent,
			}),
			agentType: info.agent,
			status,
			startedAt: info.startedAt,
			endedAt: info.endedAt,
			metrics: metricsOf(info, now, fallback),
			subtree: {},
			model: modelView(progress),
			live: status === "running" ? liveLineOf(progress) : undefined,
			completionPercent: status === "running" ? progress?.completionPercent : undefined,
			children: [],
		});
	}
	const roots: SubagentNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentId !== undefined ? nodes.get(node.parentId) : undefined;
		if (parent && parent !== node) parent.children.push(node);
		else roots.push(node);
	}
	const byStart = (a: SubagentNode, b: SubagentNode) => (a.startedAt ?? 0) - (b.startedAt ?? 0);
	const visited = new Set<string>();
	for (const root of roots) sumSubtree(root, visited);
	for (const node of nodes.values()) node.children.sort(byStart);
	return roots.sort(byStart);
}

function flatten(nodes: readonly SubagentNode[]): SubagentNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** All agents of the attached session as a tree. Roots first, by start time. */
export function subagentForest(): SubagentNode[] {
	return buildForest();
}

/** Root agents spawned by one Task call (toolCallId), with their descendants nested. */
export function subagentTree(toolCallId: string): SubagentNode[] {
	return buildForest().filter((node) => node.toolCallId === toolCallId);
}

export function fanoutTotals(toolCallId: string): {
	count: number;
	running: number;
	failed: number;
	tokens?: number;
	cost?: number;
	elapsedMs: number;
} {
	const nodes = flatten(subagentTree(toolCallId));
	const now = Date.now();
	const starts = nodes.flatMap((node) => (node.startedAt !== undefined ? [node.startedAt] : []));
	const ends = nodes.map((node) => node.endedAt ?? now);
	const elapsedMs = starts.length === 0 ? 0 : Math.max(0, Math.max(...ends) - Math.min(...starts));
	const tokens = sumKnown(nodes.map((node) => node.metrics.tokens));
	const cost = sumKnown(nodes.map((node) => node.metrics.cost));
	return {
		count: nodes.length,
		running: nodes.filter(isActiveSubagent).length,
		failed: nodes.filter((node) => node.status === "failed").length,
		tokens,
		cost,
		elapsedMs,
	};
}

/** Running or pending agents at every depth (the composer button's count; matches the dock's Running filter). */
export function runningSubagentCount(): number {
	return flatten(buildForest()).filter(isActiveSubagent).length;
}

export function subagentById(id: string): SubagentNode | undefined {
	return flatten(buildForest()).find((node) => node.id === id);
}

/**
 * A running agent's completion estimate and stage, read from its live progress
 * alone: rows that need only the estimate (wait card task jobs) skip the forest build.
 */
export function subagentEstimate(id: string): { percent: number; stage?: string } | undefined {
	const info = state.subagents.get(id);
	if (info === undefined || normalizeStatus(info.status) !== "running") return undefined;
	const progress = pickProgress(info.progress);
	if (progress?.completionPercent === undefined) return undefined;
	return { percent: progress.completionPercent, stage: progress.stage };
}

/** Hidden (false) when the action does not apply to the agent's current status. */
export function subagentCapabilities(id: string): SubagentCapabilities {
	const node = subagentById(id);
	const status = node?.status;
	return {
		steer: status === "running",
		abort: status === "running" || status === "pending",
		park: status === "done",
		// A parked worker revives unconditionally. A stopped (aborted) one only when the session's roster
		// reports its transcript resumable; either way the lifecycle reports the revived worker idle.
		revive:
			status === "parked" ||
			(status === "aborted" &&
				rosterOfSession().some((record) => record.agentId === id && record.revivable)),
	};
}

/** Agent pane actions in display order, derived only from capabilities. Inapplicable actions are absent, never disabled. */
export type AgentPaneAction = "steer" | "abort" | "park" | "revive";

export function agentPaneActions(caps: SubagentCapabilities): AgentPaneAction[] {
	const actions: AgentPaneAction[] = [];
	if (caps.steer) actions.push("steer");
	if (caps.abort) actions.push("abort");
	if (caps.park) actions.push("park");
	if (caps.revive) actions.push("revive");
	return actions;
}

export async function parkSubagent(id: string): Promise<void> {
	await parkWorker(id);
	requestRosterRefresh();
}

export async function reviveSubagent(id: string): Promise<void> {
	await reviveWorker(id);
	requestRosterRefresh();
}

/**
 * Pages of the agent's JSONL transcript are read forward from byte 0 at this size until caught up.
 * The answer carries each record twice (`entries` and `messages`) and must fit one 1 MiB callback
 * envelope (ENVELOPE_MAX_BYTES): a 256 KiB page of a real 8 MB transcript answers at most 0.48 MiB,
 * a 1 MiB page up to 1.85 MiB, which the session refuses to send.
 */
const TRANSCRIPT_PAGE_BYTES = 256 * 1024;
/** Largest page a single oversized record escalates to; its answer still has to fit the envelope. */
const TRANSCRIPT_MAX_PAGE_BYTES = 448 * 1024;

interface TranscriptSlot {
	/** Built chat items, append-only. A later tool result patches its ToolItem in place. */
	items: ChatItem[];
	/** A fetch (catch-up or incremental) is in flight. */
	loading: boolean;
	/** The first catch-up from byte 0 has reached the end of the file. */
	loaded: boolean;
	error: string | null;
	/** Cursor: the byte the next read starts from. */
	nextByte: number;
	/** `lastUpdate` of the agent when the last fetch started; a newer one means more transcript may exist. */
	seenUpdate: number;
}

const [transcripts, setTranscripts] = createStore<Record<string, TranscriptSlot>>({});

/**
 * Per-transcript item builders. They hold the call/result pairing map (not
 * reactive state) so a result landing on a later page settles its ToolItem.
 * Only built items reach the store; raw messages are never retained.
 */
const builders = new Map<string, HistoryBuilder>();

function transcriptKey(agentId: string): string {
	return JSON.stringify([state.currentWorkspaceId, agentId]);
}

/** True once the agent can no longer be running a tool (terminal or parked); unknown agents are not settled. */
function agentSettled(agentId: string): boolean {
	const status = subagentById(agentId)?.status;
	return status === "done" || status === "failed" || status === "aborted" || status === "parked";
}

/** Index of the item with `id`, searching from the end: results settle recent calls. */
function lastIndexOfId(items: readonly ChatItem[], id: number): number {
	for (let i = items.length - 1; i >= 0; i--) if (items[i]?.id === id) return i;
	return -1;
}

/**
 * A tool call with no result counts as running only while its agent runs. For
 * an agent that is no longer running the call is unfinished: it never reported
 * an outcome, so it reads as interrupted (main's settleRunningTools does the
 * same for an idle turn). A result that shows up later still patches the item.
 * A call parked on a background job is not waiting on a frame either: a transcript
 * has no live frames, so its job's outcome is unknowable and it stays a plain done card.
 */
function settleRunningTranscriptTools(key: string): void {
	const items = transcripts[key]?.items;
	if (
		!items?.some(
			(item) => item.kind === "tool" && (item.status === "running" || isBackgroundRunning(item)),
		)
	)
		return;
	setTranscripts(
		key,
		"items",
		produce((draft) => {
			for (const item of draft) {
				if (item.kind !== "tool") continue;
				if (item.status === "running") item.status = "interrupted";
				else if (isBackgroundRunning(item)) item.background = undefined;
			}
		}),
	);
}

/** Append one page: new items are pushed, results for earlier items patch those items in place. */
function applyTranscriptPage(key: string, agentId: string, res: SubagentMessagesResult): void {
	const messages = res.entries
		.filter((entry): entry is SessionMessageEntry => entry.type === "message")
		.map((entry) => entry.message);
	batch(() => {
		let builder = builders.get(key);
		if (!builder || res.reset === true) {
			// The file shrank under the cursor: the page starts over from byte 0.
			builder = createHistoryBuilder();
			builders.set(key, builder);
			setTranscripts(key, "items", []);
		}
		const built = builder.append(messages);
		setTranscripts(
			key,
			"items",
			produce((items) => {
				for (const patched of built.patched) {
					const target = items[lastIndexOfId(items, patched.id)];
					if (target?.kind !== "tool") continue;
					target.status = patched.status;
					target.output = patched.output;
					target.details = patched.details;
					target.background = patched.background ? { ...patched.background } : undefined;
					if (patched.images) target.images = patched.images;
				}
				// Copies: the builder keeps mutating its own ToolItems, which must not alias store targets.
				for (const item of built.items) items.push({ ...item });
			}),
		);
		setTranscripts(key, "nextByte", res.nextByte);
	});
	if (agentSettled(agentId)) settleRunningTranscriptTools(key);
	resolveTranscriptImages(key, agentId);
}

/** Concurrent `getSubagentImage` calls across all transcripts: each answer may be most of a 1 MiB envelope. */
const IMAGE_FETCH_CONCURRENCY = 3;
/** Resolved images kept for items built on later pages; the items themselves hold the bytes. */
const RESOLVED_IMAGE_CACHE_CAP = 32;

interface ResolvedImage {
	data: string;
	mimeType: string;
}

/** By hash: a blob is content-addressed, so every transcript referencing it shares one answer. */
const resolvedImages = new Map<string, ResolvedImage>();
/** `[transcript key, hash]` -> in flight, or failed (error, too large, missing). A failed hash is never asked again. */
const imageAttempts = new Map<string, "pending" | "failed">();
let imageSlots = IMAGE_FETCH_CONCURRENCY;
const imageWaiters: Array<() => void> = [];

async function withImageSlot<T>(task: () => Promise<T>): Promise<T> {
	if (imageSlots === 0) await new Promise<void>((wake) => imageWaiters.push(wake));
	else imageSlots -= 1;
	try {
		return await task();
	} finally {
		// A waiter inherits the slot directly.
		const next = imageWaiters.shift();
		if (next) next();
		else imageSlots += 1;
	}
}

/**
 * Write resolved bytes into every image of the transcript that still points at `hash`. The
 * ImageArg objects and their arrays keep their identity; only `data` (and a sniffed `mimeType`) change.
 */
function patchResolvedImage(key: string, hash: string, image: ResolvedImage): void {
	if (!transcripts[key]) return;
	setTranscripts(
		key,
		"items",
		produce((items) => {
			for (const item of items) {
				if (item.kind !== "user" && item.kind !== "tool") continue;
				for (const img of item.images ?? []) {
					if (imageBlobHash(img) !== hash) continue;
					img.data = image.data;
					// The server sniffs magic bytes; the transcript block's declared type stands when it cannot.
					if (image.mimeType.startsWith("image/")) img.mimeType = image.mimeType;
				}
			}
		}),
	);
}

async function fetchTranscriptImage(key: string, agentId: string, hash: string): Promise<void> {
	const attempt = JSON.stringify([key, hash]);
	imageAttempts.set(attempt, "pending");
	try {
		const res = (await withImageSlot(() =>
			call("getSubagentImage", [{ subagentId: agentId, hash }]),
		)) as SubagentImageResult;
		if (res.status !== "ok") {
			imageAttempts.set(attempt, "failed");
			return;
		}
		imageAttempts.delete(attempt);
		resolvedImages.set(hash, { data: res.data, mimeType: res.mimeType });
		if (resolvedImages.size > RESOLVED_IMAGE_CACHE_CAP) {
			resolvedImages.delete(resolvedImages.keys().next().value as string);
		}
		patchResolvedImage(key, hash, res);
	} catch {
		// Stays an `[image]` placeholder; a transient failure is not retried in a loop.
		imageAttempts.set(attempt, "failed");
	}
}

/**
 * Resolve the `blob:sha256:` images of the transcript's built items, lazily by hash: cached hashes patch
 * at once, new ones are requested with bounded concurrency. Runs after every page, so items built by
 * this page (and results patched onto earlier items) are covered; a hash already asked is not asked again.
 */
function resolveTranscriptImages(key: string, agentId: string): void {
	const wanted = new Set<string>();
	for (const item of transcripts[key]?.items ?? []) {
		if (item.kind !== "user" && item.kind !== "tool") continue;
		for (const img of item.images ?? []) {
			const hash = imageBlobHash(img);
			if (hash !== undefined) wanted.add(hash);
		}
	}
	for (const hash of wanted) {
		const cached = resolvedImages.get(hash);
		if (cached) patchResolvedImage(key, hash, cached);
		else if (!imageAttempts.has(JSON.stringify([key, hash]))) {
			void fetchTranscriptImage(key, agentId, hash);
		}
	}
}

/** Read forward from the cursor in TRANSCRIPT_PAGE_BYTES pages until caught up. */
async function fetchTranscript(key: string, agentId: string): Promise<void> {
	if (!transcripts[key]) {
		setTranscripts(key, {
			items: [],
			loading: false,
			loaded: false,
			error: null,
			nextByte: 0,
			seenUpdate: 0,
		});
	}
	if (transcripts[key]?.loading) return;
	const seen = state.subagents.get(agentId)?.lastUpdate ?? 0;
	setTranscripts(key, { loading: true, error: null });
	let pageBytes = TRANSCRIPT_PAGE_BYTES;
	try {
		for (;;) {
			const args = {
				subagentId: agentId,
				fromByte: transcripts[key]?.nextByte ?? 0,
				maxBytes: pageBytes,
			};
			let res: SubagentMessagesResult;
			try {
				res = (await call("getSubagentMessages", [args])) as SubagentMessagesResult;
			} catch (err) {
				const oversized = err instanceof Error && err.message.includes("exceeds page size");
				if (!oversized || pageBytes >= TRANSCRIPT_MAX_PAGE_BYTES) throw err;
				pageBytes = Math.min(pageBytes * 2, TRANSCRIPT_MAX_PAGE_BYTES);
				continue;
			}
			applyTranscriptPage(key, agentId, res);
			if (res.hasMore !== true) break;
		}
		setTranscripts(key, "loaded", true);
	} catch (err) {
		setTranscripts(key, { error: err instanceof Error ? err.message : String(err) });
	} finally {
		// A failed read retries only on the next progress bump, never in a loop.
		setTranscripts(key, { loading: false, seenUpdate: seen });
	}
}

/**
 * Drive one agent's transcript from a reactive scope (an effect): the first
 * call loads from byte 0 until caught up, every later progress bump reads from
 * the cursor, and an agent that stopped running settles its unfinished tools.
 */
export function syncSubagentTranscript(id: string): void {
	const key = transcriptKey(id);
	const lastUpdate = state.subagents.get(id)?.lastUpdate;
	const slot = transcripts[key];
	if (agentSettled(id)) settleRunningTranscriptTools(key);
	if (!slot) {
		untrack(() => void fetchTranscript(key, id));
		return;
	}
	if (!slot.loading && lastUpdate !== undefined && lastUpdate > slot.seenUpdate) {
		untrack(() => void fetchTranscript(key, id));
	}
}

/** Reactive view of one subagent's built transcript. Reading it never fetches; see syncSubagentTranscript. */
export function subagentTranscript(id: string): SubagentTranscriptView {
	const key = transcriptKey(id);
	return {
		get items() {
			return transcripts[key]?.items ?? [];
		},
		get loading() {
			const slot = transcripts[key];
			return slot === undefined || (slot.loading && !slot.loaded);
		},
		get error() {
			return transcripts[key]?.error ?? null;
		},
	};
}
