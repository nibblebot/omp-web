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

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
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
// Advisors. Server DTO read models. All three
// getters read advisorGetStatus with a section arg and coerce their section
// out of whatever record arrives (single-shape replies tolerated).
// ---------------------------------------------------------------------------

export interface AdvisorOverview {
	configured: boolean;
	active: boolean;
	advisors: Array<{ name: string; status: string; yielded: boolean }>;
}

function coerceAdvisorOverview(data: unknown): AdvisorOverview {
	const r = asRecord(data);
	if (r === null) return { configured: false, active: false, advisors: [] };
	const field = r.advisors;
	const list = Array.isArray(field) ? field : [];
	const advisors: AdvisorOverview["advisors"] = [];
	for (const row of list) {
		const ar = asRecord(row);
		if (ar === null) continue;
		const name = asString(ar.name);
		if (name === undefined || name === "") continue;
		advisors.push({
			name,
			status: asString(ar.status) ?? "",
			yielded: asBoolean(ar.yielded) ?? false,
		});
	}
	return {
		configured: asBoolean(r.configured) ?? false,
		active: asBoolean(r.active) ?? false,
		advisors,
	};
}

/** Server read; unavailable operations reject to the caller. */
export async function getAdvisorOverview(): Promise<AdvisorOverview> {
	return coerceAdvisorOverview(await call("advisorGetStatus", [{ section: "overview" }]));
}

/** Enable/disable advisors; rejects (throws to caller) on server failure. */
export function setAdvisorEnabled(
	enabled: boolean,
): Promise<{ enabled: boolean; active: boolean }> {
	return call("advisorConfigure", [{ enabled }]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return {
			enabled: asBoolean(r.enabled) ?? enabled,
			active: asBoolean(r.active) ?? false,
		};
	});
}

export interface AdvisorStatsDto {
	configured: boolean;
	active: boolean;
	cost: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	messages: { user: number; assistant: number; total: number };
	contextTokens: number;
	contextWindow: number;
	advisors: Array<{ name: string; status: string; cost: number; contextTokens: number }>;
}

function coerceAdvisorStats(data: unknown): AdvisorStatsDto {
	const zero: AdvisorStatsDto = {
		configured: false,
		active: false,
		cost: 0,
		tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		messages: { user: 0, assistant: 0, total: 0 },
		contextTokens: 0,
		contextWindow: 0,
		advisors: [],
	};
	const r = asRecord(data);
	if (r === null) return zero;
	const tokens: Record<string, unknown> = asRecord(r.tokens) ?? {};
	const messages: Record<string, unknown> = asRecord(r.messages) ?? {};
	const field = r.advisors;
	const list = Array.isArray(field) ? field : [];
	const advisors: AdvisorStatsDto["advisors"] = [];
	for (const row of list) {
		const ar = asRecord(row);
		if (ar === null) continue;
		const name = asString(ar.name);
		if (name === undefined || name === "") continue;
		advisors.push({
			name,
			status: asString(ar.status) ?? "",
			cost: asNumber(ar.cost) ?? 0,
			contextTokens: asNumber(ar.contextTokens) ?? 0,
		});
	}
	return {
		configured: asBoolean(r.configured) ?? false,
		active: asBoolean(r.active) ?? false,
		cost: asNumber(r.cost) ?? 0,
		tokens: {
			input: asNumber(tokens.input) ?? 0,
			output: asNumber(tokens.output) ?? 0,
			reasoning: asNumber(tokens.reasoning) ?? 0,
			cacheRead: asNumber(tokens.cacheRead) ?? 0,
			cacheWrite: asNumber(tokens.cacheWrite) ?? 0,
			total: asNumber(tokens.total) ?? 0,
		},
		messages: {
			user: asNumber(messages.user) ?? 0,
			assistant: asNumber(messages.assistant) ?? 0,
			total: asNumber(messages.total) ?? 0,
		},
		contextTokens: asNumber(r.contextTokens) ?? 0,
		contextWindow: asNumber(r.contextWindow) ?? 0,
		advisors,
	};
}

/** Server read; unavailable operations reject to the caller. */
export async function getAdvisorStats(): Promise<AdvisorStatsDto> {
	return coerceAdvisorStats(await call("advisorGetStatus", [{ section: "stats" }]));
}

/** Server read; unavailable operations reject to the caller. */
export async function getAdvisorWarnings(): Promise<{ warnings: string[] }> {
	const data = await call("advisorGetStatus", [{ section: "warnings" }]);
	if (Array.isArray(data))
		return { warnings: data.filter((v): v is string => typeof v === "string") };
	const field = asRecord(data)?.warnings;
	return {
		warnings: Array.isArray(field) ? field.filter((v): v is string => typeof v === "string") : [],
	};
}

/** Server read; unavailable operations reject to the caller. */
export async function getAdvisorHistory(opts?: {
	compact?: boolean;
	fromByte?: number;
}): Promise<{ available: boolean; text: string | null; reason?: string }> {
	const data = await call("advisorTranscript", opts !== undefined ? [opts] : []);
	const r = asRecord(data);
	if (r === null) return { available: false, text: null };
	const entry: { available: boolean; text: string | null; reason?: string } = {
		available: asBoolean(r.available) ?? false,
		text: asString(r.text) ?? null,
	};
	const reason = asString(r.reason);
	if (reason !== undefined) entry.reason = reason;
	return entry;
}

// ---------------------------------------------------------------------------
// Goals. goalCreate/goalPause/goalResume/goalDrop exist on the wire;
// Mutations use the daemon-owned goal runtime.
// ---------------------------------------------------------------------------

/** Create a goal (existing goalCreate row); rejects (throws to caller) on failure. */
export function createGoal(objective: string, tokenBudget?: number): Promise<unknown> {
	return call("goalCreate", tokenBudget !== undefined ? [objective, tokenBudget] : [objective]);
}

/** Replace the active goal through the server-owned runtime. */
export function replaceGoal(objective: string, tokenBudget?: number): Promise<unknown> {
	return call("goalReplace", tokenBudget !== undefined ? [objective, tokenBudget] : [objective]);
}

/** Set the budget through goalRuntime.onBudgetMutated. */
export function setGoalBudget(tokenBudget?: number): Promise<unknown> {
	return call("goalBudget", tokenBudget !== undefined ? [tokenBudget] : []);
}

/** Pause the active goal (existing goalPause row); rejects (throws to caller) on failure. */
export function pauseGoal(): Promise<unknown> {
	return call("goalPause", []);
}

/** Resume the paused goal (existing goalResume row); rejects (throws to caller) on failure. */
export function resumeGoal(): Promise<unknown> {
	return call("goalResume", []);
}

/** Drop the active goal (existing goalDrop row); rejects (throws to caller) on failure. */
export function dropGoal(): Promise<unknown> {
	return call("goalDrop", []);
}

// ---------------------------------------------------------------------------
// Loop policy / preview.
// ---------------------------------------------------------------------------

/** Server read; unavailable operations reject to the caller. */
export async function previewLoop(argsText: string): Promise<{
	ok: boolean;
	summary?: string;
	error?: string;
}> {
	try {
		const data = await call("loopPreview", [argsText]);
		const r: Record<string, unknown> = asRecord(data) ?? {};
		const preview: { ok: boolean; summary?: string; error?: string } = {
			ok: asBoolean(r.ok) ?? false,
		};
		const summary = asString(r.summary);
		if (summary !== undefined) preview.summary = summary;
		const error = asString(r.error);
		if (error !== undefined) preview.error = error;
		return preview;
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Server read; unavailable operations reject to the caller. */
export async function getLoopPolicy(): Promise<{
	hasPostPromptWork: boolean;
	queuedMessageCount: number;
	isStreaming: boolean;
}> {
	const data = await call("loopPolicy", []);
	const r: Record<string, unknown> = asRecord(data) ?? {};
	return {
		hasPostPromptWork: asBoolean(r.hasPostPromptWork) ?? false,
		queuedMessageCount: asNumber(r.queuedMessageCount) ?? 0,
		isStreaming: asBoolean(r.isStreaming) ?? false,
	};
}

// ---------------------------------------------------------------------------
// Vibe workers. Server DTO read models. State and
// list both read vibeStatus ({ enabled, workers }); each coerces its half.
// ---------------------------------------------------------------------------

/** Server read; unavailable operations reject to the caller. */
export async function getVibeState(): Promise<{ enabled: boolean }> {
	const data = await call("vibeStatus", []);
	const r: Record<string, unknown> = asRecord(data) ?? {};
	return { enabled: asBoolean(r.enabled) ?? false };
}

/** Set vibe mode; rejects (throws to caller) on server failure. */
export function setVibeMode(enabled: boolean): Promise<{ enabled: boolean }> {
	return call("vibeSetMode", [enabled]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { enabled: asBoolean(r.enabled) ?? enabled };
	});
}

export interface VibeWorkerDto {
	id: string;
	cli: "fast" | "good";
	state: string;
	model?: string;
	turns: number;
	queued: number;
	lastActivity?: string;
	lastActivityAt: number;
	killed?: boolean;
}

function coerceVibeWorker(row: unknown): VibeWorkerDto | null {
	const r = asRecord(row);
	if (r === null) return null;
	const id = asString(r.id);
	if (id === undefined || id === "") return null;
	const worker: VibeWorkerDto = {
		id,
		cli: asString(r.cli) === "good" ? "good" : "fast",
		state: asString(r.state) ?? "",
		turns: asNumber(r.turns) ?? 0,
		queued: asNumber(r.queued) ?? 0,
		lastActivityAt: asNumber(r.lastActivityAt) ?? 0,
	};
	const model = asString(r.model);
	if (model !== undefined) worker.model = model;
	const lastActivity = asString(r.lastActivity);
	if (lastActivity !== undefined) worker.lastActivity = lastActivity;
	const killed = asBoolean(r.killed);
	if (killed !== undefined) worker.killed = killed;
	return worker;
}

/** Server read; unavailable operations reject to the caller. */
export async function listVibeWorkers(): Promise<{ enabled: boolean; workers: VibeWorkerDto[] }> {
	const data = await call("vibeStatus", []);
	const root = asRecord(data);
	const field = root === null ? undefined : root.workers;
	const list = Array.isArray(data) ? data : Array.isArray(field) ? field : [];
	const workers: VibeWorkerDto[] = [];
	for (const row of list) {
		const coerced = coerceVibeWorker(row);
		if (coerced !== null) workers.push(coerced);
	}
	return {
		enabled: root === null ? false : (asBoolean(root.enabled) ?? false),
		workers,
	};
}

/** Spawn a vibe worker; rejects (throws to caller) on server failure. */
export function spawnVibeWorker(input: {
	cli: "fast" | "good";
	prompt: string;
	name?: string;
}): Promise<{ id: string; jobId: string }> {
	return call("vibeSpawn", [input]).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { id: asString(r.id) ?? "", jobId: asString(r.jobId) ?? "" };
	});
}

/** Send a message to a vibe worker session; rejects (throws to caller) on failure. */
export function sendVibeWorker(input: { session: string; message: string }): Promise<unknown> {
	return call("vibeSend", [input]);
}

/** Wait for vibe workers; rejects (throws to caller) on failure. */
export function waitVibeWorkers(input: {
	sessions?: string[];
	timeoutMs?: number;
}): Promise<unknown> {
	return call("vibeWait", [input]);
}

/** Kill one vibe worker; rejects (throws to caller) on failure. */
export function killVibeWorker(id: string): Promise<unknown> {
	return call("vibeKill", [id]);
}

/** Kill all vibe workers; rejects (throws to caller) on failure. */
export function killAllVibeWorkers(): Promise<{ killed: number }> {
	return call("vibeKillAll", []).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { killed: asNumber(r.killed) ?? 0 };
	});
}

/** Rehydrate vibe workers; rejects (throws to caller) on failure. */
export function rehydrateVibeWorkers(): Promise<{ restored: number }> {
	return call("vibeRehydrate", []).then((data) => {
		const r: Record<string, unknown> = asRecord(data) ?? {};
		return { restored: asNumber(r.restored) ?? 0 };
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
