/**
 * Pure reducers for the live subagent mirror (`state.subagents`). No Solid store
 * and no transport: state.ts applies these to the map, and tests drive them
 * directly. Frames are untrusted, so every reader tolerates wrong shapes.
 *
 * Progress frames carry the SDK `AgentProgress` record. A `delta: true` frame
 * (U02 coalescing) patches the previous record: an absent key is unchanged and
 * `null` clears it. A frame without `delta` is a full snapshot.
 */
import type { SubagentInfo } from "../state";
import type { SubagentMetrics, SubagentStatus } from "./subagents";

type Json = Record<string, unknown>;

/** Usage read from the session roster when no live progress record exists. */
export interface UsageFallback {
	tokens?: number;
	cost?: number;
	contextTokens?: number;
	contextWindow?: number;
}

export type SubagentMap = ReadonlyMap<string, SubagentInfo>;

const TERMINAL_RAW: Record<string, true> = { completed: true, failed: true, aborted: true };

function rec(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Terminal wire statuses (`completed`, `failed`, `aborted`). */
export function isTerminalRaw(status: string | undefined): boolean {
	return status !== undefined && TERMINAL_RAW[status] === true;
}

/** Maps the wire status vocabulary onto the UI contract. `idle` (finished turn, still live) reads as done. */
export function normalizeStatus(raw: string | undefined): SubagentStatus {
	switch (raw) {
		case "running":
		case "started":
			return "running";
		case "completed":
		case "idle":
		case "done":
			return "done";
		case "failed":
			return "failed";
		case "aborted":
			return "aborted";
		case "parked":
			return "parked";
		default:
			return "pending";
	}
}

/** Full frames replace the record (nulls dropped). Delta frames patch it: absent = unchanged, null = cleared. */
export function mergeProgress(previous: Json | undefined, incoming: Json, delta: boolean): Json {
	const next: Json = delta && previous ? { ...previous } : {};
	for (const [key, value] of Object.entries(incoming)) {
		if (value === undefined) continue;
		if (value === null) delete next[key];
		else next[key] = value;
	}
	return next;
}

function findByIndex(
	map: SubagentMap,
	index: number | undefined,
	parentToolCallId: string | undefined,
): string | undefined {
	if (index === undefined) return undefined;
	for (const [key, sub] of map) {
		if (
			sub.index === index &&
			(parentToolCallId === undefined ||
				sub.parentToolCallId === undefined ||
				sub.parentToolCallId === parentToolCallId)
		) {
			return key;
		}
	}
	return undefined;
}

/** Applies a `subagent_lifecycle` frame. Returns a new map; the input is never mutated. */
export function applyLifecycleFrame(
	previous: SubagentMap,
	payload: unknown,
	now: number,
): Map<string, SubagentInfo> {
	const next = new Map(previous);
	const p = rec(payload);
	const id = str(p?.id);
	if (!p || !id) return next;
	const index = num(p.index);
	// Progress frames that raced ahead of this lifecycle frame created a `progress-<index>` placeholder.
	const placeholderKey = index !== undefined ? `progress-${index}` : undefined;
	const placeholder = placeholderKey !== undefined ? next.get(placeholderKey) : undefined;
	if (placeholderKey !== undefined) next.delete(placeholderKey);
	const existing = next.get(id);
	const prior = existing ?? placeholder;
	const incoming = str(p.status) ?? placeholder?.status ?? "started";
	// A late non-terminal lifecycle frame must not reopen an agent already finished.
	const status =
		prior && isTerminalRaw(prior.status) && !isTerminalRaw(incoming) ? prior.status : incoming;
	next.set(id, {
		id,
		index: index ?? prior?.index ?? -1,
		agent: str(p.agent) ?? prior?.agent ?? "agent",
		description: str(p.description) ?? prior?.description,
		task: existing?.task ?? placeholder?.task,
		status,
		lastUpdate: now,
		parentToolCallId: str(p.parentToolCallId) ?? prior?.parentToolCallId,
		progress: existing?.progress ?? placeholder?.progress,
		startedAt: prior?.startedAt ?? now,
		endedAt: isTerminalRaw(status) ? (prior?.endedAt ?? now) : undefined,
	});
	return next;
}

/** Applies a `subagent_progress` frame, full or delta. Keys by `progress.id`; `index` is the id-less fallback. */
export function applyProgressFrame(
	previous: SubagentMap,
	payload: unknown,
	now: number,
): Map<string, SubagentInfo> {
	const next = new Map(previous);
	const p = rec(payload);
	const progress = rec(p?.progress);
	if (!p || !progress) return next;
	const index = num(p.index);
	const parentToolCallId = str(p.parentToolCallId);
	const key =
		str(progress.id) ??
		findByIndex(previous, index, parentToolCallId) ??
		(index !== undefined ? `progress-${index}` : undefined);
	if (key === undefined) return next;
	const existing = next.get(key);
	const merged = mergeProgress(existing?.progress, progress, p.delta === true);
	const status = str(merged.status) ?? existing?.status ?? "started";
	const durationMs = num(merged.durationMs);
	next.set(key, {
		id: key,
		index: existing?.index ?? index ?? -1,
		agent: str(p.agent) ?? existing?.agent ?? "agent",
		description: str(merged.description) ?? existing?.description,
		task: str(p.task) ?? str(merged.task) ?? existing?.task,
		status,
		lastUpdate: now,
		parentToolCallId: parentToolCallId ?? existing?.parentToolCallId,
		progress: merged,
		startedAt: existing?.startedAt ?? (durationMs !== undefined ? now - durationMs : now),
		endedAt: isTerminalRaw(status) ? (existing?.endedAt ?? now) : undefined,
	});
	return next;
}

/** Metrics for one agent. Live progress wins; the roster usage is the fallback when no live record exists. */
export function metricsOf(
	info: SubagentInfo,
	now: number,
	fallback?: UsageFallback,
): SubagentMetrics {
	const p = info.progress;
	const usage: UsageFallback | undefined = p
		? {
				tokens: num(p.tokens),
				cost: num(p.cost),
				contextTokens: num(p.contextTokens),
				contextWindow: num(p.contextWindow),
			}
		: fallback;
	const durationMs = num(p?.durationMs);
	const span = (info.endedAt ?? now) - (info.startedAt ?? now);
	const window = usage?.contextWindow;
	const contextTokens = usage?.contextTokens;
	return {
		elapsedMs: Math.max(0, durationMs ?? span),
		contextPercent:
			window !== undefined && window > 0 && contextTokens !== undefined
				? (contextTokens / window) * 100
				: undefined,
		tokens: usage?.tokens,
		cost: usage?.cost,
	};
}
