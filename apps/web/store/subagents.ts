import { call } from "./transport";
import { pushNotice } from "./chat";
import { setState, state, type SubagentInfo } from "../state";

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
		tokens: number;
		requests: number;
		cost: number;
		contextTokens?: number;
		contextWindow?: number;
	};
	unread: number;
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
					tokens: asNumber(progress.tokens) ?? 0,
					requests: asNumber(progress.requests) ?? 0,
					cost: asNumber(progress.cost) ?? 0,
					contextTokens: asNumber(progress.contextTokens),
					contextWindow: asNumber(progress.contextWindow),
				}
			: undefined,
		unread: 0,
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

/** Resume a revived worker; rejects (throws to caller) on server failure. */
export function resumeWorker(agentId: string): Promise<{ id: string; status: string }> {
	return call("workerResume", [agentId]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { id: asString(r.id) ?? agentId, status: asString(r.status) ?? "" };
	});
}

// ---------------------------------------------------------------------------
// Component-layer glue: transient presentation helpers for the worker hub.
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

export interface WorkerActivity {
	anchor: string;
	key: string;
	sessionId: string;
	agentId: string;
	type: "subagent_lifecycle" | "subagent_progress" | "subagent_event";
	time: number;
	payload: unknown;
}

export interface WorkersState {
	records: Record<string, WorkerRecord>;
	order: string[];
	activity: Record<string, WorkerActivity>;
	activityOrder: string[];
	replayGaps: Record<string, true>;
}

export function createWorkersState(): WorkersState {
	return { records: {}, order: [], activity: {}, activityOrder: [], replayGaps: {} };
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
			unread: old?.unread ?? 0,
			progress: record.progress ?? old?.progress,
			usage: record.usage ?? old?.usage,
			parentAgentId: record.parentAgentId ?? old?.parentAgentId,
		};
	}
	const replayGaps = { ...previous.replayGaps };
	delete replayGaps[sessionId];
	return { ...previous, records, order, replayGaps };
}

/** Stable SSE anchors deduplicate replay; receipt time is never used as an event identity. */
export function reduceWorkerEvent(
	previous: WorkersState,
	sessionId: string,
	type: WorkerActivity["type"],
	payload: unknown,
	anchor: string,
	time: number,
): WorkersState {
	const eventKey = JSON.stringify([sessionId, anchor]);
	if (!anchor || previous.activity[eventKey]) return previous;
	const row = asRecord(payload);
	if (!row) return previous;
	const progress = asRecord(row.progress);
	const id = asString(row.id) ?? asString(progress?.id);
	if (!id) return previous;
	const key = workerKey(sessionId, id);
	const old = previous.records[key];
	// Progress and raw events cannot invent a live worker before lifecycle/snapshot discovery.
	if (!old && type !== "subagent_lifecycle") return previous;
	if (
		old?.parentToolCallId &&
		row.parentToolCallId &&
		old.parentToolCallId !== row.parentToolCallId
	)
		return previous;
	if (old?.sessionFile && row.sessionFile && old.sessionFile !== row.sessionFile) return previous;
	if (old && isTerminalWorker(old.status) && type === "subagent_progress") return previous;
	const record = coerceWorkerRow(
		{
			...old,
			...row,
			id,
			status: progress?.status ?? row.status ?? old?.status,
			lastActivity: time,
		},
		sessionId,
	);
	if (!record) return previous;
	record.unread = (old?.unread ?? 0) + 1;
	const activity: WorkerActivity = { anchor, key, sessionId, agentId: id, type, time, payload };
	return {
		...previous,
		records: { ...previous.records, [key]: record },
		order: old ? previous.order : [...previous.order, key],
		activity: { ...previous.activity, [eventKey]: activity },
		activityOrder: [...previous.activityOrder, eventKey],
	};
}

export function markWorkerReplayGap(previous: WorkersState, sessionId: string): WorkersState {
	return { ...previous, replayGaps: { ...previous.replayGaps, [sessionId]: true } };
}

export function markWorkerRead(previous: WorkersState, key: string): WorkersState {
	const record = previous.records[key];
	if (!record || record.unread === 0) return previous;
	return { ...previous, records: { ...previous.records, [key]: { ...record, unread: 0 } } };
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
