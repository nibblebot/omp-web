/**
 * Port of the TUI's context-thresholds.ts breakpoints (status-line coloring).
 * Percent threshold and absolute-token threshold, whichever trips first.
 */
export type ContextUsageLevel = "normal" | "warning" | "purple" | "error";

const WARNING = { percent: 50, tokens: 150_000 };
const PURPLE = { percent: 70, tokens: 270_000 };
const ERROR = { percent: 90, tokens: 500_000 };

function reaches(percent: number, window: number, threshold: { percent: number; tokens: number }): boolean {
	if (!Number.isFinite(percent) || percent <= 0) return false;
	if (!Number.isFinite(window) || window <= 0) return percent >= threshold.percent;
	return percent >= Math.min(threshold.percent, (threshold.tokens / window) * 100);
}

export function getContextUsageLevel(percent: number, contextWindow: number): ContextUsageLevel {
	if (reaches(percent, contextWindow, ERROR)) return "error";
	if (reaches(percent, contextWindow, PURPLE)) return "purple";
	if (reaches(percent, contextWindow, WARNING)) return "warning";
	return "normal";
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 10_000) return `${Math.round(n / 1000)}k`;
	if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
	return String(n);
}
