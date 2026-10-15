import type { ChatItem } from "../state";
import type { UsageLike } from "../usage/usage";

/** Minimum prefix the previous turn must have READ from cache before a collapse counts as an invalidation (pi-tui cache-invalidation-marker.ts). */
const MIN_CACHE_FOOTPRINT = 2048;

/** Per-assistant display metadata derived from neighbouring transcript items. */
export interface TurnMeta {
	/** Prompt-to-completion wall time in ms (display.showTurnTime), when both ends are stamped. */
	turnMs?: number;
	/** Prompt tokens re-processed after the cache went cold (display.cacheMissMarker). */
	cacheMissTokens?: number;
}

/**
 * Reprocessed prompt tokens when `current` lost a warm cache that `prev` was
 * reading, else undefined. Same rules as the SDK's detectCacheInvalidation:
 * the previous turn must have read a meaningful prefix, this turn read none
 * but re-created it (explicit caches report cacheWrite > 0; implicit
 * best-effort caches do not, so they never flag).
 */
export function detectCacheInvalidation(
	prev: UsageLike | undefined,
	current: UsageLike,
): number | undefined {
	if (!prev || prev.cacheRead < MIN_CACHE_FOOTPRINT) return undefined;
	if (current.cacheRead > 0 || current.cacheWrite <= 0) return undefined;
	const reprocessed = current.cacheWrite + current.input;
	return reprocessed < MIN_CACHE_FOOTPRINT ? undefined : reprocessed;
}

/** Prompt-to-completion time: the latest preceding user prompt's timestamp to the assistant's completion. */
export function turnElapsedMs(
	turnStartedAt: number | undefined,
	completedAt: number | undefined,
): number | undefined {
	if (turnStartedAt === undefined || completedAt === undefined) return undefined;
	const elapsed = completedAt - turnStartedAt;
	return elapsed > 0 ? Math.round(elapsed) : undefined;
}

/**
 * One pass over the transcript producing metadata per assistant item id.
 * Only the requested derivations run, so callers with both toggles off pay
 * nothing. A user item anchors the turn; the cache baseline is the latest
 * assistant turn that carried any prompt tokens (cache read/write/input).
 */
export function buildTurnMeta(
	items: readonly ChatItem[],
	want: { turnTime: boolean; cacheMiss: boolean },
): Map<number, TurnMeta> {
	const meta = new Map<number, TurnMeta>();
	if (!want.turnTime && !want.cacheMiss) return meta;
	let turnStartedAt: number | undefined;
	let lastUsage: UsageLike | undefined;
	for (const item of items) {
		if (item.kind === "user") {
			turnStartedAt = item.timestamp;
			continue;
		}
		if (item.kind !== "assistant") continue;
		const entry: TurnMeta = {};
		if (want.turnTime) {
			const ms = turnElapsedMs(turnStartedAt, item.completedAt);
			if (ms !== undefined) entry.turnMs = ms;
		}
		if (item.usage) {
			if (want.cacheMiss) {
				const miss = detectCacheInvalidation(lastUsage, item.usage);
				if (miss !== undefined) entry.cacheMissTokens = miss;
			}
			if (item.usage.cacheRead + item.usage.cacheWrite + item.usage.input > 0)
				lastUsage = item.usage;
		}
		if (entry.turnMs !== undefined || entry.cacheMissTokens !== undefined) meta.set(item.id, entry);
	}
	return meta;
}

/**
 * Turn-anchor stamp for a user message: its timestamp when a user prompt
 * starts a turn (not agent-attributed follow-ups, the TUI's rule).
 */
export function promptTimestamp(msg: {
	timestamp?: unknown;
	attribution?: string;
}): number | undefined {
	if (msg.attribution === "agent") return undefined;
	return typeof msg.timestamp === "number" ? msg.timestamp : undefined;
}
