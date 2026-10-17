import { createStore } from "solid-js/store";
import type { SubagentMessagesResult } from "#lib/wire/protocol";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { lastToolOf, metricsOf, normalizeStatus, type UsageFallback } from "./subagent-frames";
import { call } from "./transport";
import { pushNotice } from "./chat";
import { setState, state, type SubagentInfo } from "../state";
import { sumKnown } from "../subagents/format";

/**
 * Subagents domain (Phase 3 store facade split). The subagent mirror itself
 * (state.subagents) is maintained by the connect() mux in state.ts; this
 * module owns the mid-task steering/abort actions.
 *
 * All worker/advisor/goal/vibe reads go through `call()` (POST /command id
 * dedup + SSE call_result + ring replay). No new transport.
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
	unavailableReason?: string;
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

/** Usage the daemon retained for a finished worker; undefined when it reported none. */
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
		unavailableReason: asString(r.unavailableReason),
		hasHistory: asBoolean(r.hasHistory) ?? sessionFile !== null,
		lastActivity: asNumber(r.lastActivity) ?? asNumber(r.lastUpdate) ?? 0,
		createdAt: asNumber(r.createdAt) ?? 0,
		adopted: asBoolean(r.adopted) ?? false,
		revivable: asBoolean(r.revivable) ?? false,
	};
}

/** Failures reject: an unavailable roster must not look like an empty success. */
export async function listWorkers(): Promise<WorkerRecord[]> {
	const sessionId = state.currentSessionId;
	if (!sessionId) throw new Error("No session attached");
	const data = await call("workerList", []);
	const field = asRecord(data)?.workers;
	const list = Array.isArray(data) ? data : Array.isArray(field) ? field : null;
	if (!list) throw new Error("Invalid worker roster");
	if (state.currentSessionId !== sessionId)
		throw new Error("Session switched during worker discovery");
	setState("workers", (previous) => normalizeWorkerSnapshot(previous, sessionId, list));
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

/** Revive a parked worker; rejects (throws to caller) on server failure. */
export function reviveWorker(agentId: string): Promise<{ id: string; status: string }> {
	return call("workerRevive", [agentId]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { id: asString(r.id) ?? agentId, status: asString(r.status) ?? "" };
	});
}

// ---------------------------------------------------------------------------
// Component-layer glue: transient presentation helpers for the agents dock.
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
		records[record.key] = {
			...old,
			...record,
			progress: record.progress ?? old?.progress,
			usage: record.usage ?? old?.usage,
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
	const live = sessionId === state.currentSessionId ? state.subagents.get(agentId) : undefined;
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
	if (sessionId === state.currentSessionId) for (const id of state.subagents.keys()) ids.add(id);
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
	label: string;
	agentType?: string;
	status: SubagentStatus;
	startedAt?: number;
	endedAt?: number;
	metrics: SubagentMetrics;
	/** Self plus descendants. Never context percent. */
	subtree: { tokens?: number; cost?: number };
	lastTool?: string;
	children: SubagentNode[];
}

export interface SubagentCapabilities {
	steer: boolean;
	abort: boolean;
	park: boolean;
	revive: boolean;
}

export interface SubagentTranscriptView {
	readonly entries: readonly SessionMessageEntry[];
	readonly loading: boolean;
	readonly error: string | null;
	readonly hasMore: boolean;
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

/** Coalesced roster refetch on lifecycle edges (SUB-10). Retries with backoff while the daemon is unreachable. */
export function requestRosterRefresh(): void {
	rosterGeneration += 1;
	scheduleRoster(0, rosterGeneration);
}

function rosterOfSession(): WorkerRecord[] {
	const sessionId = state.currentSessionId;
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
		nodes.set(id, {
			id,
			parentId: record?.parentAgentId,
			toolCallId: info.parentToolCallId ?? record?.parentToolCallId,
			label: info.description ?? record?.description ?? record?.displayName ?? info.agent,
			agentType: info.agent,
			status: resolveStatus(state.subagents.get(id), record),
			startedAt: info.startedAt,
			endedAt: info.endedAt,
			metrics: metricsOf(info, now, fallback),
			subtree: {},
			lastTool: lastToolOf(info),
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
		running: nodes.filter((node) => node.status === "running").length,
		failed: nodes.filter((node) => node.status === "failed").length,
		tokens,
		cost,
		elapsedMs,
	};
}

/** Every agent the dock lists: roster (survives reload) merged with the live mirror. */
export function subagentCount(): number {
	return flatten(buildForest()).length;
}

export function runningSubagentCount(): number {
	return flatten(buildForest()).filter((node) => node.status === "running").length;
}

export function subagentById(id: string): SubagentNode | undefined {
	return flatten(buildForest()).find((node) => node.id === id);
}

/** Hidden (false) when the action does not apply to the agent's current status. */
export function subagentCapabilities(id: string): SubagentCapabilities {
	const node = subagentById(id);
	const status = node?.status;
	return {
		steer: status === "running",
		abort: status === "running" || status === "pending",
		park: status === "done",
		// Revive applies to a parked worker; the session re-registers it and the lifecycle reports it idle.
		revive: status === "parked",
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

const [transcripts, setTranscripts] = createStore<
	Record<
		string,
		{
			entries: SessionMessageEntry[];
			loading: boolean;
			error: string | null;
			hasMore: boolean;
			loaded: boolean;
			nextByte: number;
			seenUpdate: number;
		}
	>
>({});

function transcriptKey(agentId: string): string {
	return JSON.stringify([state.currentSessionId, agentId]);
}

async function fetchTranscript(key: string, agentId: string, fromByte?: number): Promise<void> {
	if (!transcripts[key]) {
		setTranscripts(key, {
			entries: [],
			loading: false,
			error: null,
			hasMore: false,
			loaded: false,
			nextByte: 0,
			seenUpdate: 0,
		});
	}
	if (transcripts[key]?.loading) return;
	const seen = state.subagents.get(agentId)?.lastUpdate ?? 0;
	setTranscripts(key, { loading: true, error: null });
	try {
		const args: { subagentId: string; fromByte?: number } = { subagentId: agentId };
		if (fromByte !== undefined) args.fromByte = fromByte;
		const res = (await call("getSubagentMessages", [args])) as SubagentMessagesResult;
		const incoming = res.entries.filter(
			(entry): entry is SessionMessageEntry => entry.type === "message",
		);
		const replace = fromByte === undefined || res.reset === true;
		setTranscripts(key, "entries", (prev) => {
			if (replace) return incoming;
			const known = new Set(prev.map((entry) => entry.id));
			return [...prev, ...incoming.filter((entry) => !known.has(entry.id))];
		});
		setTranscripts(key, {
			nextByte: res.nextByte,
			hasMore: res.hasMore === true,
			loaded: true,
			seenUpdate: seen,
		});
	} catch (err) {
		setTranscripts(key, { error: err instanceof Error ? err.message : String(err) });
	} finally {
		setTranscripts(key, "loading", false);
	}
}

/** Reactive, live transcript of one subagent. The first read fetches; live updates append from the last byte. */
export function subagentTranscript(id: string): SubagentTranscriptView {
	const key = transcriptKey(id);
	const lastUpdate = state.subagents.get(id)?.lastUpdate;
	const slot = transcripts[key];
	if (!slot) queueMicrotask(fetchTranscript.bind(undefined, key, id));
	else if (!slot.loading && lastUpdate !== undefined && lastUpdate > slot.seenUpdate) {
		const from = slot.loaded ? slot.nextByte : undefined;
		queueMicrotask(fetchTranscript.bind(undefined, key, id, from));
	}
	return {
		get entries() {
			return transcripts[key]?.entries ?? [];
		},
		get loading() {
			return transcripts[key]?.loading ?? true;
		},
		get error() {
			return transcripts[key]?.error ?? null;
		},
		get hasMore() {
			return transcripts[key]?.hasMore ?? false;
		},
	};
}

/** Fetches the next page of an older transcript. No-op when there is no more history. */
export async function loadMoreSubagentTranscript(id: string): Promise<void> {
	const key = transcriptKey(id);
	const slot = transcripts[key];
	if (!slot?.hasMore || slot.loading) return;
	await fetchTranscript(key, id, slot.nextByte);
}
