/** Compact duration for subagent rows: `850ms`, `12s`, `1m05s`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total}s`;
	return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/** Token count: `842`, `12.4k`, `1.3M`. */
export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Dollar cost; three decimals under a dollar so small agents do not read as `$0.00`. */
export function formatCost(cost: number): string {
	return cost < 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}
