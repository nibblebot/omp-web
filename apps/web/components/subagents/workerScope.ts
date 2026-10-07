import type { SubagentInfo } from "../../state";

/** Authoritative lineage only: a tool-call ID is not a worker ID. */
export function workerParentId(sub: SubagentInfo): string | undefined {
	return "parentAgentId" in sub && typeof sub.parentAgentId === "string"
		? sub.parentAgentId
		: undefined;
}

/**
 * Worker-hub client scope helpers (G04/G10).
 *
 * Ownership: the server owns durable agent state; `apps/web/store/*` owns the
 * normalized `state.subagents` mirror; this module owns TRANSIENT hub
 * presentation only (drafts, seen-marks, pin prefs, filter parsing). Nothing
 * here is written into the shared store facade.
 *
 * Main-draft seam: `preserveMainDraft` / `readMainDraft` persist the Main
 * composer buffer to localStorage keyed by session. PromptBox-adjacent code
 * can adopt the pair later (preserve on worker focus, restore on return);
 * this slice never edits PromptBox itself.
 */

// ---------------------------------------------------------------------------
// Focused-draft map (module scope, never in the shared store)
// ---------------------------------------------------------------------------

/** Module-scope unsent composer buffers. Worker keys are `${sessionId}::${agentId}`; Main is `main:${sessionId}`. */
const focusDrafts = new Map<string, string>();

export function getFocusDraft(key: string): string {
	return focusDrafts.get(key) ?? "";
}

export function setFocusDraft(key: string, text: string): void {
	if (text) focusDrafts.set(key, text);
	else focusDrafts.delete(key);
}

// ---------------------------------------------------------------------------
// Main-draft localStorage seam (PromptBox integration point)
// ---------------------------------------------------------------------------

// localStorage key: `omp.mainDraft.<sessionId>` (integration seam for PromptBox adoption).

function storageGet(key: string): string {
	try {
		return typeof localStorage !== "undefined" ? (localStorage.getItem(key) ?? "") : "";
	} catch {
		return "";
	}
}

function storageSet(key: string, value: string): void {
	try {
		if (typeof localStorage !== "undefined") localStorage.setItem(key, value);
	} catch {
		// Private-mode / quota: drafts stay in the module map only.
	}
}

/**
 * Preserve the Main composer buffer before focusing a worker. Backed by
 * localStorage so a later PromptBox adoption can restore it after return.
 */
export function preserveMainDraft(sessionId: string, text: string): void {
	setFocusDraft(`main:${sessionId}`, text);
	storageSet(`omp.mainDraft.${sessionId}`, text);
}

/** Read the preserved Main draft ("" when none). */
export function readMainDraft(sessionId: string): string {
	return getFocusDraft(`main:${sessionId}`) || storageGet(`omp.mainDraft.${sessionId}`);
}

// ---------------------------------------------------------------------------
// Unread derivation (render-time; the state.ts mux is NOT touched)
// ---------------------------------------------------------------------------

/**
 * Why render-time: the subagent_lifecycle/subagent_progress mux lives in
 * state.ts (frozen lane), so the hub cannot set unread flags on frames.
 * Instead each row compares `sub.lastUpdate` against the module-level
 * `lastSeen` mark written when the worker is focused, plus explicit
 * `markWorkerUnread` marks (e.g. a lifecycle notice for a backgrounded
 * worker). Workers never focused are NOT dotted — absence of a mark means
 * "not yet viewed", not "unread".
 */
const lastSeen = new Map<string, number>();
const unreadIds = new Set<string>();

/** Explicit unread mark for one worker id (exported helper). */
export function markWorkerUnread(id: string): void {
	unreadIds.add(id);
}

/** Record that a worker was viewed (call on focus). Clears explicit marks. */
export function markWorkerSeen(sub: Pick<SubagentInfo, "id" | "lastUpdate">): void {
	lastSeen.set(sub.id, sub.lastUpdate);
	unreadIds.delete(sub.id);
}

/** Render-time unread test for hub rows. */
export function isWorkerUnread(sub: Pick<SubagentInfo, "id" | "lastUpdate">): boolean {
	if (unreadIds.has(sub.id)) return true;
	const seen = lastSeen.get(sub.id);
	if (seen === undefined) return false;
	return sub.lastUpdate > seen;
}

// ---------------------------------------------------------------------------
// Pinned worker density pref (localStorage, default "full")
// ---------------------------------------------------------------------------

/**
 * Per-worker detail density: "collapsed" = header row + actions only,
 * "full" = transcript + inspector, "off" = hidden from the hub list behind
 * a "show hidden (N)" recovery toggle. "off" deliberately does NOT hide the
 * ActiveSubagents strip entry — the strip keeps identical behavior per its
 * contract; strip hiding is a future seam, not silent filtering.
 */
export type WorkerPin = "collapsed" | "full" | "off";

// localStorage key: `omp.workerPin.<agentId>` (default "full").

export function getWorkerPin(agentId: string): WorkerPin {
	try {
		const raw =
			typeof localStorage !== "undefined" ? localStorage.getItem(`omp.workerPin.${agentId}`) : null;
		if (raw === "collapsed" || raw === "full" || raw === "off") return raw;
	} catch {
		// Fall through to default.
	}
	return "full";
}

export function setWorkerPin(agentId: string, pin: WorkerPin): void {
	storageSet(`omp.workerPin.${agentId}`, pin);
}

// ---------------------------------------------------------------------------
// Hub search / filter vocabulary
// ---------------------------------------------------------------------------

/**
 * Minimal text-token vocabulary (documented, kept simple):
 * - `agent:<name>` scopes to agent/displayName (substring, case-insensitive).
 * - `status:<s>` filters status (substring, e.g. `status:fail`).
 * - `has:text` keeps workers whose description/task text is non-empty.
 * - `is:tool` keeps workers whose agent name is tool-ish, i.e. in
 *   {task, sonic, background, tool} (the SDK-spawned helper set).
 * Remaining tokens are fuzzy AND-terms matched (substring) against
 * id + agent + description + task + parentToolCallId.
 */
export const TOOL_AGENTS: Record<string, true> = {
	task: true,
	sonic: true,
	background: true,
	tool: true,
};

export interface HubFilter {
	agent?: string;
	status?: string;
	hasText: boolean;
	isTool: boolean;
	tokens: string[];
}

export function parseHubFilter(query: string): HubFilter {
	const filter: HubFilter = { hasText: false, isTool: false, tokens: [] };
	for (const raw of query.trim().split(/\s+/)) {
		if (!raw) continue;
		const lower = raw.toLowerCase();
		if (lower.startsWith("agent:")) {
			filter.agent = lower.slice("agent:".length);
		} else if (lower.startsWith("status:")) {
			filter.status = lower.slice("status:".length);
		} else if (lower === "has:text") {
			filter.hasText = true;
		} else if (lower === "is:tool") {
			filter.isTool = true;
		} else {
			filter.tokens.push(lower);
		}
	}
	return filter;
}

export function matchSubagent(sub: SubagentInfo, filter: HubFilter): boolean {
	const agent = (sub.agent ?? "").toLowerCase();
	if (filter.agent && !agent.includes(filter.agent)) return false;
	if (filter.status && !(sub.status ?? "").toLowerCase().includes(filter.status)) return false;
	if (filter.hasText && !(sub.description ?? sub.task ?? "").trim()) return false;
	if (filter.isTool && TOOL_AGENTS[agent] !== true) return false;
	if (filter.tokens.length > 0) {
		const haystack =
			`${sub.id} ${sub.agent ?? ""} ${sub.description ?? ""} ${sub.task ?? ""} ${sub.parentToolCallId ?? ""}`.toLowerCase();
		for (const token of filter.tokens) {
			if (!haystack.includes(token)) return false;
		}
	}
	return true;
}

// ---------------------------------------------------------------------------
// Lifecycle permission + error classification
// ---------------------------------------------------------------------------

const STEERABLE_STATUSES: Record<string, true> = {
	running: true,
	started: true,
	pending: true,
	idle: true,
};

const TERMINAL_STATUSES: Record<string, true> = {
	completed: true,
	done: true,
	failed: true,
	error: true,
	aborted: true,
};

/**
 * Null when the worker accepts steering; otherwise the read-only banner
 * reason. Advisor transcripts are always read-only; terminal/tombstoned and
 * unavailable workers are read-only history; parked workers must revive first.
 */
export function steerBlockReason(sub: SubagentInfo): string | null {
	const agent = (sub.agent ?? "").toLowerCase();
	if (agent === "advisor" || agent.includes("advisor")) {
		return "advisor transcripts are read-only";
	}
	if ("kind" in sub && sub.kind === "advisor") return "advisor transcripts are read-only";
	if ("artifactAvailability" in sub && sub.artifactAvailability === "missing")
		return "worker unavailable — missing history or artifacts";
	if (sub.status === "unavailable") return "worker unavailable — missing history or artifacts";
	if (sub.status === "parked") return "worker parked — revive before steering";
	if (TERMINAL_STATUSES[sub.status] === true)
		return `worker ${sub.status} — terminal, history is read-only`;
	if (STEERABLE_STATUSES[sub.status] !== true) return `worker ${sub.status} — not steerable`;
	return null;
}

/** Park is a live transition; Main never appears here (the mirror only tracks subagents). */
export function canPark(sub: SubagentInfo): boolean {
	return sub.status === "running" || sub.status === "started" || sub.status === "pending";
}

/** Only parked (non-tombstoned) workers revive; aborted workers never do. */
export function canRevive(sub: SubagentInfo): boolean {
	return sub.status === "parked";
}

/** Idle workers resume in place without a revive cycle. */
export function canResume(sub: SubagentInfo): boolean {
	return sub.status === "idle";
}

export function canAbort(sub: SubagentInfo): boolean {
	return sub.status === "running" || sub.status === "started" || sub.status === "pending";
}

export type LifecycleErrorKind = "terminal" | "unavailable" | "no-such-agent" | "other";

/** Classify revive/resume failures from server message substrings. */
export function classifyLifecycleError(message: string): LifecycleErrorKind {
	const lower = message.toLowerCase();
	if (lower.includes("no such agent")) return "no-such-agent";
	if (lower.includes("unavailable")) return "unavailable";
	if (lower.includes("terminal")) return "terminal";
	return "other";
}

/** Defensive model label: SubagentInfo carries no model field; WorkerRecord snapshots may. */
export function workerModel(sub: SubagentInfo): string | undefined {
	// Invariant: the server mirror only adds optional JSON fields, so a named
	// assertion at this in-process boundary is sound.
	const extras = sub as unknown as { model?: unknown };
	return typeof extras.model === "string" && extras.model ? extras.model : undefined;
}
