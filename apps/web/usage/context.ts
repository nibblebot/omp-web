/**
 * Port of the TUI's context-thresholds.ts breakpoints (status-line coloring).
 * Percent threshold and absolute-token threshold, whichever trips first.
 */
export type ContextUsageLevel = "normal" | "warning" | "purple" | "error";

const WARNING = { percent: 50, tokens: 150_000 };
const PURPLE = { percent: 70, tokens: 270_000 };
const ERROR = { percent: 90, tokens: 500_000 };

function reaches(
	percent: number,
	window: number,
	threshold: { percent: number; tokens: number },
): boolean {
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

/** Compact k/M magnitude for a token count ("1.2k", "128k", "1.2M"), shared by
 *  formatTokens and formatCtx. `keepDecimals` keeps the one-decimal forms
 *  ("1.0M", "1.5k"); without it, values round to whole numbers and trailing
 *  ".0" is trimmed ("1M", "2k"). */
export function formatCompactTokens(n: number, keepDecimals: boolean): string {
	if (n >= 1_000_000) {
		const m = (n / 1_000_000).toFixed(1);
		return keepDecimals ? `${m}M` : `${m.replace(/\.0$/, "")}M`;
	}
	if (keepDecimals && n >= 1000 && n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	return formatCompactTokens(n, true);
}
