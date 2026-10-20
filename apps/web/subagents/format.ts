/** Compact duration for subagent rows: `850ms`, `12s`, `1m05s`. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total}s`;
	return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

/** Token count: `842`, `12.4k`, `1.3M`. */
export function formatTokens(count: number | undefined): string {
	if (count === undefined) return "-";
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/** Dollar cost; three decimals under a dollar so small agents do not read as `$0.00`. */
export function formatCost(cost: number | undefined): string {
	if (cost === undefined) return "-";
	return cost < 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

/** Sum of the known values: 0 for no values, undefined when values exist but none is known. */
export function sumKnown(values: readonly (number | undefined)[]): number | undefined {
	if (values.length === 0) return 0;
	let total: number | undefined;
	for (const value of values) if (value !== undefined) total = (total ?? 0) + value;
	return total;
}

/** Short agent name: the last dot segment of the id (`Parent.Child-2` -> `Child-2`); the `-N` dedup suffix stays. */
export function shortAgentName(id: string): string {
	const dot = id.lastIndexOf(".");
	return dot >= 0 && dot < id.length - 1 ? id.slice(dot + 1) : id;
}

/** Row title: the description, else the first non-empty assignment line, else the display name. */
export function agentTitle(source: {
	description?: string;
	/** Candidate task texts in preference order (assignment, then task). */
	assignments?: readonly (string | undefined)[];
	displayName: string;
}): string {
	const description = source.description?.trim();
	if (description) return description;
	for (const text of source.assignments ?? []) {
		const line = text?.split(/\r?\n/).find((l) => l.trim() !== "");
		if (line !== undefined) return line.trim();
	}
	return source.displayName;
}
