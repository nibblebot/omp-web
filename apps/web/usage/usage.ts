import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
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

/** Seconds with one decimal, e.g. "3.2s". */
export function formatDurationMs(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Compact throughput, e.g. "425 tok/s". */
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

/** Locale-grouped integer for usage amounts ("1,250"); a dash when absent. */
export function formatAmount(n: number | undefined): string {
	if (n === undefined || !Number.isFinite(n)) return "-";
	return n.toLocaleString("en-US");
}

// Dollars with two decimals and grouping ("$1,234.50"), sub-cent amounts rounded to the cent. Built on
// first use, once, like the turn-stamp formatters below.
let usdFormat: Intl.NumberFormat | undefined;

/**
 * Unit-aware UsageAmount rendering: tokens use the compact k/M formatter,
 * percents append "%", usd reads as dollars ("$12.35 / $100.00"), everything
 * else is locale-grouped ("1,250 / 5,000"). Missing values render as a dash
 * so limits without amounts stay readable.
 */
export function formatUnitAmount(amount: { used?: number; limit?: number; unit: string }): string {
	const v = (n: number | undefined) =>
		n === undefined || !Number.isFinite(n)
			? "-"
			: amount.unit === "tokens"
				? formatTokens(n)
				: amount.unit === "usd"
					? (usdFormat ??= new Intl.NumberFormat("en-US", {
							style: "currency",
							currency: "USD",
						})).format(n)
					: formatAmount(n);
	const used = v(amount.used);
	const suffix = amount.unit === "percent" && amount.used !== undefined ? "%" : "";
	return amount.limit !== undefined ? `${used} / ${v(amount.limit)}${suffix}` : `${used}${suffix}`;
}

/**
 * Percent of a limit used, clamped to 0..100, for drawing its bar; undefined
 * when the report gives no usable ratio (an uncapped budget), which draws no
 * bar rather than an empty one.
 */
export function resolveUsedPercent(limit: UsageLimit): number | undefined {
	const frac = resolveUsedFraction(limit);
	return frac === undefined || !Number.isFinite(frac)
		? undefined
		: Math.max(0, Math.min(100, frac * 100));
}

/**
 * Fraction of a limit used (0..1), or undefined when the report gives no
 * usable ratio. Local copy of pi-ai's resolveUsedFraction, since a runtime value
 * import from @oh-my-pi/pi-ai pulls the package's non-JS assets into the
 * vite dep graph and breaks the optimizer (documented plan constraint:
 * type-only imports only).
 */
export function resolveUsedFraction(limit: UsageLimit): number | undefined {
	const a = limit.amount;
	if (typeof a.usedFraction === "number" && Number.isFinite(a.usedFraction)) return a.usedFraction;
	if (typeof a.used === "number" && typeof a.limit === "number" && a.limit > 0)
		return a.used / a.limit;
	if (typeof a.remainingFraction === "number" && Number.isFinite(a.remainingFraction))
		return 1 - a.remainingFraction;
	if (typeof a.remaining === "number" && typeof a.limit === "number" && a.limit > 0)
		return 1 - a.remaining / a.limit;
	return undefined;
}

/**
 * Fraction of a limit's window already elapsed (0..1) at `nowMs`, to set
 * against its used fraction. Undefined without both `durationMs` and
 * `resetsAt`, or when `resetLabel` marks `resetsAt` as a regen/tick step
 * rather than the window end.
 */
export function resolveElapsedFraction(limit: UsageLimit, nowMs: number): number | undefined {
	const w = limit.window;
	if (!w || (w.resetLabel !== undefined && w.resetLabel !== "resets")) return undefined;
	const { durationMs, resetsAt } = w;
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0)
		return undefined;
	if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return undefined;
	return Math.max(0, Math.min(1, 1 - (resetsAt - nowMs) / durationMs));
}

/** Brand whose logo marks a provider account in the sidebar usage panel. */
export type UsageBrand = "anthropic" | "openai" | "opencode";

/**
 * Logo brand for a usage provider id: `anthropic`, the `openai*` family
 * (`openai-codex`), and the `opencode*` family (`opencode-go`). Undefined for
 * any other provider, which renders a lettered fallback.
 */
export function usageBrand(provider: string): UsageBrand | undefined {
	if (provider === "anthropic") return "anthropic";
	if (provider === "openai" || provider.startsWith("openai-")) return "openai";
	if (provider === "opencode" || provider.startsWith("opencode-")) return "opencode";
	return undefined;
}

const TURN_STAMP_FIELDS: Intl.DateTimeFormatOptions = {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
};
// Built on first use, once: constructing a formatter per call costs far more than formatting with one.
let turnStampSameYear: Intl.DateTimeFormat | undefined;
let turnStampOtherYear: Intl.DateTimeFormat | undefined;

/**
 * Wall-clock stamp for a turn on the usage row: local "Oct 20, 14:32", with
 * the year when it differs from `nowMs`'s.
 */
export function formatTurnStamp(ms: number, nowMs: number): string {
	const at = new Date(ms);
	if (at.getFullYear() === new Date(nowMs).getFullYear()) {
		turnStampSameYear ??= new Intl.DateTimeFormat(undefined, TURN_STAMP_FIELDS);
		return turnStampSameYear.format(at);
	}
	turnStampOtherYear ??= new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		...TURN_STAMP_FIELDS,
	});
	return turnStampOtherYear.format(at);
}

const MINUTE_MS = 60_000;

/**
 * Time left until a window resets, floored, two units at most: "3d 4h",
 * "1h 35m", "12m", "<1m"; "now" once the reset time has passed (the report is
 * older than the window).
 */
export function formatTimeRemaining(resetsAt: number, nowMs: number): string {
	const left = resetsAt - nowMs;
	if (left <= 0) return "now";
	const minutes = Math.floor(left / MINUTE_MS);
	if (minutes < 1) return "<1m";
	const d = Math.floor(minutes / 1440);
	const h = Math.floor((minutes % 1440) / 60);
	const m = minutes % 60;
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m`;
}

/** Hover text for one account: provider id plus the account email or id when reported. */
export function usageAccountTitle(report: UsageReport): string {
	const meta = report.metadata ?? {};
	const who = [meta.email, meta.accountId].find(
		(v): v is string => typeof v === "string" && v !== "",
	);
	return who ? `${report.provider} · ${who}` : report.provider;
}

/** Hover text for one limit bar: its label, percent used, and local reset time. */
export function usageLimitTitle(limit: UsageLimit): string {
	const frac = resolveUsedFraction(limit);
	const parts = [limit.label];
	if (frac !== undefined) parts.push(`${Math.round(frac * 100)}% used`);
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt !== undefined)
		parts.push(`${limit.window?.resetLabel ?? "resets"} ${new Date(resetsAt).toLocaleString()}`);
	return parts.join(" · ");
}
