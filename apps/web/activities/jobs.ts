/**
 * The Jobs section's row logic: which rows its filter shows and how a poll row sits in a flat list.
 * Pure; the section feeds it `activityJobRows()` and the store's filter and expanded ids.
 */
import type { ActivityFilter } from "../store/slices/activities";
import type { ActivityJobRow } from "./summary";

/**
 * Rows the filter lets through, in poll order. `running` keeps the running jobs, plus the
 * `keep` ids (jobs open inline) so a job that settles does not vanish from under the reader.
 */
export function visibleJobRows(
	rows: readonly ActivityJobRow[],
	filter: ActivityFilter,
	keep: ReadonlySet<string>,
): readonly ActivityJobRow[] {
	if (filter === "all") return rows;
	return rows.filter((row) => row.job.status === "running" || keep.has(row.job.id));
}

/**
 * The poll nests a job under the subagent that owns it, but the section hides task jobs (those
 * are subagents), so a nested row would hang from a branch nobody sees: list every row at the top.
 */
export function flatJobRow(row: ActivityJobRow): ActivityJobRow {
	return row.depth === 0 ? row : { ...row, depth: 0, rails: [], last: true, parent: false };
}
