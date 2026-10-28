import { batch, createSignal, untrack } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { SubagentImageResult, SubagentMessagesResult } from "#lib/wire/protocol";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { isBackgroundRunning } from "../chat/background-job";
import {
	createHistoryBuilder,
	type HistoryAppend,
	type HistoryBuilder,
} from "../chat/history-items";
import {
	applyLifecycleFrame,
	applyProgressFrame,
	metricsOf,
	metricsUseClock,
	normalizeStatus,
	type UsageFallback,
} from "./subagent-frames";
import { call } from "./transport";
import { pushNotice } from "./chat";
import { setState, setView, state, type ChatItem, type SubagentInfo } from "../state";
import { api } from "./fleet-api";
import { subagentAnalysisHash } from "./slices/analysis";
import { agentTitle, shortAgentName, sumKnown } from "../subagents/format";
import { ReactiveMap } from "../subagents/reactive-map";
import { isActiveSubagent, type SubagentTotals } from "../subagents/tree";
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
 * (state.subagents) is written only by the connect() mux in state.ts, through
 * applySubagentLifecycle/applySubagentProgress below; this module owns the
 * mid-task steering/abort actions, the shared forest and the transcripts.
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
// Durable agent state stays server-side; the state.subagents mirror is written
// only by the connect() mux (via the two frame actions below).
// ---------------------------------------------------------------------------

/**
 * The live mirror, updated in place. `state.subagents` is a `ReactiveMap` (in place, per-agent
 * readers); a plain Map written there (a test seed, a fixture) is upgraded once, on the first frame.
 */
function liveSubagentMirror(): Map<string, SubagentInfo> {
	const mirror = state.subagents;
	if (mirror instanceof ReactiveMap) return mirror;
	const upgraded = ReactiveMap.from(mirror);
	setState("subagents", upgraded);
	return upgraded;
}

/** Apply a `subagent_lifecycle` frame to the mirror. Only the readers of the agents it touches rerun. */
export function applySubagentLifecycle(payload: unknown): void {
	batch(() => applyLifecycleFrame(liveSubagentMirror(), payload, Date.now()));
}

/** Apply a `subagent_progress` frame to the mirror. Only the readers of the agent it touches rerun. */
export function applySubagentProgress(payload: unknown): void {
	batch(() => applyProgressFrame(liveSubagentMirror(), payload, Date.now()));
}

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

/** Structural equality of JSON-like data (roster rows carry nested progress and usage records). */
function sameData(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	if (keys.length !== Object.keys(right).length) return false;
	return keys.every((key) => key in right && sameData(left[key], right[key]));
}

/**
 * Snapshots rediscover workers without deleting retained terminal history or unread activity. A row
 * that did not change keeps its record object, and a snapshot that changed nothing returns
 * `previous`, so a refresh with nothing new notifies nobody (the forest keeps every node).
 */
export function normalizeWorkerSnapshot(
	previous: WorkersState,
	sessionId: string,
	rows: unknown[],
): WorkersState {
	let records = previous.records;
	let order = previous.order;
	for (const row of rows) {
		const record = coerceWorkerRow(row, sessionId);
		if (!record) continue;
		const old = records[record.key];
		// Progress and the usage derived from it are a live sample (the first roster read after a spawn can
		// carry one taken 45 ms in). Keep them only while the worker runs; once it settles the row's own
		// usage (retained at finish, or summed from its transcript) is the truth, and absent means unknown.
		const running =
			record.status === "pending" || record.status === "started" || record.status === "running";
		const merged = {
			...old,
			...record,
			progress: record.progress ?? (running ? old?.progress : undefined),
			usage: record.usage ?? (running ? old?.usage : undefined),
			parentAgentId: record.parentAgentId ?? old?.parentAgentId,
		};
		if (old === undefined) {
			if (order === previous.order) order = [...order];
			order.push(record.key);
		} else if (sameData(old, merged)) {
			continue;
		}
		if (records === previous.records) records = { ...records };
		records[record.key] = merged;
	}
	return records === previous.records && order === previous.order
		? previous
		: { ...previous, records, order };
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

/** Backoff between retries while the session is unreachable; a fresh request restarts it. */
const ROSTER_RETRY_MS = [500, 1500, 4000];
/** Least time between two roster reads: the edges of a fan-out share one trailing read. */
const ROSTER_MIN_INTERVAL_MS = 500;

let rosterTimer: ReturnType<typeof setTimeout> | undefined;
let rosterInFlight = false;
let rosterWanted = false;
let rosterStartedAt = Number.NEGATIVE_INFINITY;
let rosterFailures = 0;

function armRoster(delayMs: number): void {
	rosterTimer = setTimeout(() => {
		rosterTimer = undefined;
		void runRoster();
	}, delayMs);
}

function paceDelay(): number {
	return Math.max(0, rosterStartedAt + ROSTER_MIN_INTERVAL_MS - Date.now());
}

async function runRoster(): Promise<void> {
	rosterWanted = false;
	rosterInFlight = true;
	rosterStartedAt = Date.now();
	let retryMs: number | undefined;
	try {
		await listWorkers();
		rosterFailures = 0;
	} catch {
		retryMs = ROSTER_RETRY_MS[rosterFailures];
		rosterFailures += 1;
	} finally {
		rosterInFlight = false;
	}
	if (retryMs !== undefined) armRoster(retryMs);
	else if (rosterWanted) armRoster(paceDelay());
}

/**
 * Roster refetch on lifecycle edges (SUB-10), single-flight and paced: at most one read in flight and
 * one per ROSTER_MIN_INTERVAL_MS, requests meanwhile collapse into one trailing read. Retries with
 * backoff while the session is unreachable.
 */
export function requestRosterRefresh(): void {
	rosterWanted = true;
	rosterFailures = 0;
	if (rosterInFlight) return;
	clearTimeout(rosterTimer);
	armRoster(paceDelay());
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

/** What a forest node was built from: the node is reused while these and its children stay the same. */
interface ForestEntry {
	live: SubagentInfo | undefined;
	record: WorkerRecord | undefined;
	status: SubagentStatus;
	/** The node's metrics read the clock (a running agent that reports no duration), so it never repeats. */
	clock: boolean;
	node: SubagentNode;
}

interface Forest {
	/** Distinguishes builds; a result computed from one build is valid for exactly that build. */
	readonly build: number;
	readonly roots: readonly SubagentNode[];
	readonly byId: ReadonlyMap<string, SubagentNode>;
	/** Root agents per Task call. An unchanged group keeps its array. */
	readonly byToolCall: ReadonlyMap<string, readonly SubagentNode[]>;
	/** Running or pending agents at every depth. */
	readonly active: number;
}

const NO_NODES: readonly SubagentNode[] = [];
let forestEntries = new Map<string, ForestEntry>();
let lastForest: Forest | undefined;
let forestBuilds = 0;

function sameNodes(a: readonly SubagentNode[], b: readonly SubagentNode[]): boolean {
	return a.length === b.length && a.every((node, i) => node === b[i]);
}

/** The row of a roster-only worker, shaped like a live mirror entry. */
function infoOfRecord(record: WorkerRecord): SubagentInfo {
	return {
		id: record.agentId,
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
}

function makeNode(
	info: SubagentInfo,
	record: WorkerRecord | undefined,
	status: SubagentStatus,
	children: SubagentNode[],
	now: number,
): SubagentNode {
	const fallback: UsageFallback | undefined = record?.usage;
	const progress = pickProgress(info.progress);
	const metrics = metricsOf(info, now, fallback);
	return {
		id: info.id,
		parentId: record?.parentAgentId,
		toolCallId: info.parentToolCallId ?? record?.parentToolCallId,
		name: shortAgentName(info.id),
		title: agentTitle({
			description: info.description ?? record?.description,
			assignments: [record?.assignment, record?.task ?? info.task],
			displayName: record?.displayName ?? info.agent,
		}),
		agentType: info.agent,
		status,
		startedAt: info.startedAt,
		endedAt: info.endedAt,
		metrics,
		subtree: {
			tokens: sumKnown([metrics.tokens, ...children.map((child) => child.subtree.tokens)]),
			cost: sumKnown([metrics.cost, ...children.map((child) => child.subtree.cost)]),
		},
		model: modelView(progress),
		live: status === "running" ? liveLineOf(progress) : undefined,
		completionPercent: status === "running" ? progress?.completionPercent : undefined,
		children,
	};
}

const byStart = (a: SubagentNode, b: SubagentNode) => (a.startedAt ?? 0) - (b.startedAt ?? 0);

/**
 * Builds the whole forest from the live mirror and the roster. A node whose inputs did not change
 * (same mirror entry, same roster record, same status, same children) is the very object of the
 * previous build, so anything keyed on node identity sees only the agents that actually changed.
 */
function buildForest(): Forest {
	forestBuilds += 1;
	const now = Date.now();
	const records = new Map(rosterOfSession().map((record) => [record.agentId, record] as const));
	const sources = new Map<
		string,
		{ live: SubagentInfo | undefined; record: WorkerRecord | undefined }
	>();
	for (const [id, live] of state.subagents) sources.set(id, { live, record: records.get(id) });
	for (const [id, record] of records) {
		if (!sources.has(id)) sources.set(id, { live: undefined, record });
	}
	const childIds = new Map<string, string[]>();
	const rootIds: string[] = [];
	for (const [id, { record }] of sources) {
		const parentId = record?.parentAgentId;
		if (parentId !== undefined && parentId !== id && sources.has(parentId)) {
			const siblings = childIds.get(parentId);
			if (siblings) siblings.push(id);
			else childIds.set(parentId, [id]);
		} else rootIds.push(id);
	}
	// Agents in a parent cycle have no root above them and stay out, as they always have.
	const previous = forestEntries;
	const entries = new Map<string, ForestEntry>();
	const byId = new Map<string, SubagentNode>();
	let active = 0;
	const resolve = (id: string): SubagentNode => {
		const { live, record } = sources.get(id) ?? { live: undefined, record: undefined };
		const status = resolveStatus(live, record);
		const children = (childIds.get(id) ?? []).map(resolve).sort(byStart);
		const old = previous.get(id);
		let entry: ForestEntry;
		if (
			old !== undefined &&
			old.live === live &&
			old.record === record &&
			old.status === status &&
			!old.clock &&
			sameNodes(old.node.children, children)
		) {
			entry = old;
		} else {
			const info = live ?? (record ? infoOfRecord(record) : undefined);
			if (info === undefined) throw new Error(`subagent ${id} has no source`);
			entry = {
				live,
				record,
				status,
				clock: metricsUseClock(info),
				node: makeNode(info, record, status, children, now),
			};
		}
		entries.set(id, entry);
		byId.set(id, entry.node);
		if (isActiveSubagent(entry.node)) active += 1;
		return entry.node;
	};
	const roots = rootIds.map(resolve).sort(byStart);
	forestEntries = entries;
	const grouped = new Map<string, SubagentNode[]>();
	for (const root of roots) {
		if (root.toolCallId === undefined) continue;
		const group = grouped.get(root.toolCallId);
		if (group) group.push(root);
		else grouped.set(root.toolCallId, [root]);
	}
	const byToolCall = new Map<string, readonly SubagentNode[]>();
	for (const [toolCallId, group] of grouped) {
		const old = lastForest?.byToolCall.get(toolCallId);
		byToolCall.set(toolCallId, old !== undefined && sameNodes(old, group) ? old : group);
	}
	for (const toolCallId of totalsCache.keys()) {
		if (!byToolCall.has(toolCallId)) totalsCache.delete(toolCallId);
	}
	lastForest = { build: forestBuilds, roots, byId, byToolCall, active };
	return lastForest;
}

interface ForestCache {
	mirror: ReactiveMap<string, SubagentInfo>;
	version: number;
	records: unknown;
	order: unknown;
	workspace: string;
	forest: Forest;
}
let forestCache: ForestCache | undefined;

/**
 * The forest every consumer reads: built once per change of its sources (the live mirror, the roster,
 * the attached session) however many readers ask. A plain Map in `state.subagents` (a test seed) cannot
 * say when it changes in place, so it is rebuilt per call.
 */
function currentForest(): Forest {
	const mirror = state.subagents;
	const records = state.workers.records;
	const order = state.workers.order;
	const workspace = state.currentWorkspaceId;
	if (!(mirror instanceof ReactiveMap)) return buildForest();
	const version = mirror.version;
	const hit = forestCache;
	if (
		hit !== undefined &&
		hit.mirror === mirror &&
		hit.version === version &&
		hit.records === records &&
		hit.order === order &&
		hit.workspace === workspace
	) {
		return hit.forest;
	}
	const forest = buildForest();
	forestCache = { mirror, version, records, order, workspace, forest };
	return forest;
}

/** All agents of the attached session as a tree. Roots first, by start time. Shared: never mutate it. */
export function subagentForest(): readonly SubagentNode[] {
	return currentForest().roots;
}

/** Root agents spawned by one Task call (toolCallId), with their descendants nested. Shared: never mutate it. */
export function subagentTree(toolCallId: string): readonly SubagentNode[] {
	return currentForest().byToolCall.get(toolCallId) ?? NO_NODES;
}

function flatten(nodes: readonly SubagentNode[]): SubagentNode[] {
	return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

interface CachedTotals {
	build: number;
	roots: readonly SubagentNode[];
	totals: SubagentTotals;
}
const totalsCache = new Map<string, CachedTotals>();

/**
 * Totals of one Task call's agents. Computed once per forest build; a call whose agents all settled
 * and did not change keeps the same object across builds (a running call's elapsed time moves).
 */
export function fanoutTotals(toolCallId: string): SubagentTotals {
	const forest = currentForest();
	const roots = forest.byToolCall.get(toolCallId) ?? NO_NODES;
	const hit = totalsCache.get(toolCallId);
	if (
		hit !== undefined &&
		(hit.build === forest.build || (hit.roots === roots && hit.totals.running === 0))
	) {
		return hit.totals;
	}
	const nodes = flatten(roots);
	const now = Date.now();
	const starts = nodes.flatMap((node) => (node.startedAt !== undefined ? [node.startedAt] : []));
	const ends = nodes.map((node) => node.endedAt ?? now);
	const elapsedMs = starts.length === 0 ? 0 : Math.max(0, Math.max(...ends) - Math.min(...starts));
	const totals: SubagentTotals = {
		count: nodes.length,
		running: nodes.filter(isActiveSubagent).length,
		failed: nodes.filter((node) => node.status === "failed").length,
		tokens: sumKnown(nodes.map((node) => node.metrics.tokens)),
		cost: sumKnown(nodes.map((node) => node.metrics.cost)),
		elapsedMs,
	};
	totalsCache.set(toolCallId, { build: forest.build, roots, totals });
	return totals;
}

/** Running or pending agents at every depth (the composer button's count; matches the dock's Running filter). */
export function runningSubagentCount(): number {
	return currentForest().active;
}

export function subagentById(id: string): SubagentNode | undefined {
	return currentForest().byId.get(id);
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
	/** `lastUpdate` of the agent when the last fetch started. */
	seenUpdate: number;
	/** `transcriptStamp` of the agent when the last fetch started; a different one means the transcript grew. */
	seenStamp: string;
	/** Identifies this slot instance: a fetch that outlives its slot (evicted, or evicted and reopened) must not write. */
	gen: number;
}

const [transcripts, setTranscripts] = createStore<Record<string, TranscriptSlot>>({});
let slotSeq = 0;
/** Item ids stay unique across builders: a builder dropped at settle is replaced by a fresh one on a revive. */
let transcriptItemSeq = 0;
const nextTranscriptItemId = (): number => (transcriptItemSeq += 1);

/** Closed transcripts kept for a quick reopen; the least recently closed go first. */
const RETAINED_CLOSED_TRANSCRIPTS = 3;
/** Panes showing a transcript, per key (the dock and an accordion row can show one agent at once). */
const holders = new Map<string, number>();
/** Transcripts no pane shows, oldest closed first. */
const closedTranscripts = new Set<string>();

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

/** True while some tool call of the transcript has no result yet. */
function hasRunningTranscriptTool(key: string): boolean {
	return (
		transcripts[key]?.items.some(
			(item) => item.kind === "tool" && (item.status === "running" || isBackgroundRunning(item)),
		) ?? false
	);
}

/** Append one page: new items are pushed, results for earlier items patch those items in place. */
function applyTranscriptPage(key: string, agentId: string, res: SubagentMessagesResult): void {
	const messages = res.entries
		.filter((entry): entry is SessionMessageEntry => entry.type === "message")
		.map((entry) => entry.message);
	let built: HistoryAppend | undefined;
	batch(() => {
		let builder = builders.get(key);
		if (res.reset === true) {
			// The file shrank under the cursor: the page starts over from byte 0.
			builder = createHistoryBuilder(nextTranscriptItemId);
			builders.set(key, builder);
			setTranscripts(key, "items", []);
		} else if (!builder) {
			// Dropped when the agent settled (see below); only the tail after the cursor is new.
			builder = createHistoryBuilder(nextTranscriptItemId);
			builders.set(key, builder);
		}
		const appended = builder.append(messages);
		built = appended;
		setTranscripts(
			key,
			"items",
			produce((items) => {
				for (const patched of appended.patched) {
					const target = items[lastIndexOfId(items, patched.id)];
					if (target?.kind !== "tool") continue;
					target.status = patched.status;
					target.output = patched.output;
					target.details = patched.details;
					target.background = patched.background ? { ...patched.background } : undefined;
					if (patched.images) target.images = patched.images;
				}
				// Copies: the builder keeps mutating its own ToolItems, which must not alias store targets.
				for (const item of appended.items) items.push({ ...item });
			}),
		);
		setTranscripts(key, "nextByte", res.nextByte);
	});
	if (agentSettled(agentId)) {
		const unresolved = hasRunningTranscriptTool(key);
		settleRunningTranscriptTools(key);
		// A settled agent writes no more pages, and with every call answered nothing is left to pair:
		// the builder's call map (every ToolItem of the transcript) can go. A revive starts a new one.
		if (!unresolved && res.hasMore !== true) builders.delete(key);
	}
	if (built) resolveTranscriptImages(key, agentId, built);
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
 * Resolve the `blob:sha256:` images of one page, lazily by hash: cached hashes patch at once, new ones
 * are requested with bounded concurrency. Covers the items this page built and the earlier items its
 * results patched; a hash already asked is not asked again.
 */
function resolveTranscriptImages(key: string, agentId: string, page: HistoryAppend): void {
	const wanted = new Set<string>();
	for (const item of [...page.items, ...page.patched]) {
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

/**
 * What of an agent's progress says its transcript grew: a model request or tool call finished or
 * started, or the status moved. Streaming deltas and the running clock change nothing on disk.
 */
function transcriptStamp(info: SubagentInfo): string {
	const p = info.progress;
	return [info.status, p?.requests, p?.toolCount, p?.currentTool, p?.currentToolStartMs].join("|");
}

/** An agent that keeps reporting without a visible change is still read this often. */
const TRANSCRIPT_POLL_MS = 5000;

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
			seenStamp: "",
			gen: (slotSeq += 1),
		});
	}
	const gen = transcripts[key]?.gen;
	const alive = (): boolean => transcripts[key]?.gen === gen;
	if (transcripts[key]?.loading) return;
	const info = state.subagents.get(agentId);
	const seen = info?.lastUpdate ?? 0;
	const stamp = info === undefined ? "" : transcriptStamp(info);
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
				if (!alive() || !oversized || pageBytes >= TRANSCRIPT_MAX_PAGE_BYTES) throw err;
				pageBytes = Math.min(pageBytes * 2, TRANSCRIPT_MAX_PAGE_BYTES);
				continue;
			}
			if (!alive()) return;
			applyTranscriptPage(key, agentId, res);
			if (res.hasMore !== true) break;
		}
		setTranscripts(key, "loaded", true);
	} catch (err) {
		if (alive()) setTranscripts(key, { error: err instanceof Error ? err.message : String(err) });
	} finally {
		// A failed read retries only on the next progress bump, never in a loop.
		if (alive()) setTranscripts(key, { loading: false, seenUpdate: seen, seenStamp: stamp });
	}
}

/**
 * Drive one agent's transcript from a reactive scope (an effect): the first call loads from byte 0
 * until caught up, a later progress frame reads from the cursor when it shows the transcript grew
 * (or the agent has been silent in the transcript for TRANSCRIPT_POLL_MS), and an agent that stopped
 * running settles its unfinished tools.
 */
export function syncSubagentTranscript(id: string): void {
	const key = transcriptKey(id);
	const info = state.subagents.get(id);
	const slot = transcripts[key];
	// Untracked: settling reads every item, and the pages that add items settle them themselves.
	if (agentSettled(id)) untrack(() => settleRunningTranscriptTools(key));
	if (!slot) {
		untrack(() => void fetchTranscript(key, id));
		return;
	}
	if (slot.loading || info === undefined || info.lastUpdate <= slot.seenUpdate) return;
	if (
		transcriptStamp(info) !== slot.seenStamp ||
		info.lastUpdate - slot.seenUpdate >= TRANSCRIPT_POLL_MS
	) {
		untrack(() => void fetchTranscript(key, id));
	}
}

/** Drop one transcript: its items, its builder and the image requests made for it. */
function evictTranscript(key: string): void {
	closedTranscripts.delete(key);
	builders.delete(key);
	const prefix = `[${JSON.stringify(key)},`;
	for (const attempt of imageAttempts.keys()) {
		if (attempt.startsWith(prefix)) imageAttempts.delete(attempt);
	}
	setTranscripts(
		produce((all) => {
			delete all[key];
		}),
	);
}

/**
 * A pane shows this agent's transcript until the returned release runs. Transcripts no pane shows
 * are kept only for the RETAINED_CLOSED_TRANSCRIPTS most recently closed; a reopened one resumes
 * from its cursor, an evicted one reloads.
 */
export function holdSubagentTranscript(id: string): () => void {
	const key = transcriptKey(id);
	holders.set(key, (holders.get(key) ?? 0) + 1);
	closedTranscripts.delete(key);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		const left = (holders.get(key) ?? 1) - 1;
		if (left > 0) {
			holders.set(key, left);
			return;
		}
		holders.delete(key);
		if (!transcripts[key]) return;
		closedTranscripts.add(key);
		for (const oldest of closedTranscripts) {
			if (closedTranscripts.size <= RETAINED_CLOSED_TRANSCRIPTS) break;
			evictTranscript(oldest);
		}
	};
}

/**
 * Drop every transcript and what hangs off it (builders, image answers). Run when the attached
 * session changes: the agents of the session left behind are not coming back, and their transcripts
 * are the largest thing the page holds. A pane still showing one reloads it from byte 0.
 */
export function clearSubagentTranscripts(): void {
	builders.clear();
	closedTranscripts.clear();
	imageAttempts.clear();
	resolvedImages.clear();
	setTranscripts(
		produce((all) => {
			for (const key of Object.keys(all)) delete all[key];
		}),
	);
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
