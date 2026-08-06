import { formatTokens } from "./context";

/**
 * Per-turn token usage for one assistant message. Structurally compatible
 * with pi-catalog's `Usage` (input/output/cacheRead/cacheWrite/…); kept local
 * so this module stays pure and the client never depends on SDK types.
 */
export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
}

/** Normalized per-turn usage row rendered under a settled assistant message. */
export interface UsageRow {
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	/** Time to first token in ms (AssistantMessage.ttft). */
	ttftMs?: number;
	/** Output tokens per second (output / duration). */
	tokensPerSec?: number;
}

/**
 * Build the row for one assistant message. Returns null when no usage was
 * reported (e.g. custom agent messages without telemetry) so callers can
 * skip the footer entirely.
 */
export function buildUsageRow(
	usage: UsageLike | undefined,
	ttft?: number,
	duration?: number,
): UsageRow | null {
	if (!usage) return null;
	const row: UsageRow = {
		tokensIn: usage.input,
		tokensOut: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
	};
	if (typeof ttft === "number" && Number.isFinite(ttft) && ttft > 0) row.ttftMs = ttft;
	if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
		const tps = usage.output / (duration / 1000);
		if (Number.isFinite(tps)) row.tokensPerSec = Math.round(tps);
	}
	return row;
}

/** "3.2s" — seconds with one decimal. */
export function formatDurationMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** "425 tok/s" — compact throughput. */
export function formatTokensPerSec(tps: number): string {
	return `${formatTokens(tps)} tok/s`;
}

/**
 * Compact one-line rendering: "↑1.2k ↓340 · cache 5.1k/0 · ttft 0.8s · 425 tok/s".
 * Segments with zero/absent values are dropped.
 */
export function formatUsageRow(row: UsageRow): string {
	const parts = [`↑${formatTokens(row.tokensIn)} ↓${formatTokens(row.tokensOut)}`];
	if (row.cacheRead > 0 || row.cacheWrite > 0)
		parts.push(`cache ${formatTokens(row.cacheRead)}/${formatTokens(row.cacheWrite)}`);
	if (row.ttftMs !== undefined) parts.push(`ttft ${formatDurationMs(row.ttftMs)}`);
	if (row.tokensPerSec !== undefined) parts.push(formatTokensPerSec(row.tokensPerSec));
	return parts.join(" · ");
}

/** Locale-grouped integer for usage amounts ("1,250"); "—" when absent. */
export function formatAmount(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "—";
	return n.toLocaleString("en-US");
}

/**
 * Unit-aware UsageAmount rendering: tokens use the compact k/M formatter,
 * percents append "%", everything else is locale-grouped ("1,250 / 5,000").
 * Missing values render as "—" so limits without amounts stay readable.
 */
export function formatUnitAmount(amount: { used?: number; limit?: number; unit: string }): string {
	const v = (n: number | undefined) =>
		n === undefined ? "—" : amount.unit === "tokens" ? formatTokens(n) : formatAmount(n);
	const used = v(amount.used);
	const suffix = amount.unit === "percent" && amount.used !== undefined ? "%" : "";
	return amount.limit !== undefined ? `${used} / ${v(amount.limit)}${suffix}` : `${used}${suffix}`;
}
