import type { ToolRowChoice } from "../prefs/display";

/** The row cap a `toolRows` preference means: a count, or every row for "all". */
export function toolRowLimit(choice: ToolRowChoice): number {
	return choice === "all" ? Number.POSITIVE_INFINITY : Number(choice);
}

/**
 * The rows a capped tool card shows and how many it hides. `head` keeps the first
 * `limit` rows (file content); `tail` keeps the last `limit` (terminal output, where
 * the end is what matters). A limit at or past the row count hides nothing.
 */
export function capRows<T>(
	rows: readonly T[],
	limit: number,
	keep: "head" | "tail",
): { shown: readonly T[]; hidden: number } {
	if (rows.length <= limit) return { shown: rows, hidden: 0 };
	return {
		shown: keep === "tail" ? rows.slice(rows.length - limit) : rows.slice(0, limit),
		hidden: rows.length - limit,
	};
}
