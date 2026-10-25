/**
 * What the Activities surfaces count: the status-line buttons, their popovers
 * and the panel's sections all read these selectors and never re-derive.
 * Pure reads of the store, reactive when called inside a tracking scope.
 */
import type { DaemonInfo, JobTreeRowDto } from "#lib/wire/protocol";
import { isLiveDaemon, state } from "../state";
import { jobTreeRows } from "../store/job-poll";
import { subagentForest } from "../store/subagents";
import { flattenSubagentTree, isActiveSubagent } from "../subagents/tree";

export interface ActivitySummary {
	total: number;
	active: number;
	/** Something is listed and none of it is active any more. */
	settled: boolean;
}

export interface TodoSummary {
	total: number;
	/** Completed or abandoned tasks. */
	done: number;
	settled: boolean;
}

/** A `kind: "job"` row of the shared job poll. */
export type ActivityJobRow = Extract<JobTreeRowDto, { kind: "job" }>;

function summarize(total: number, active: number): ActivitySummary {
	return { total, active, settled: total > 0 && active === 0 };
}

/** Every subagent at every depth; active = running or pending. */
export function subagentsSummary(): ActivitySummary {
	const nodes = flattenSubagentTree(subagentForest());
	return summarize(nodes.length, nodes.filter(isActiveSubagent).length);
}

/** The Jobs section's rows: job rows of the poll, minus task jobs (those are subagents). */
export function activityJobRows(): readonly ActivityJobRow[] {
	return jobTreeRows().filter(
		(row): row is ActivityJobRow => row.kind === "job" && row.job.type !== "task",
	);
}

export function jobsSummary(): ActivitySummary {
	const rows = activityJobRows();
	return summarize(rows.length, rows.filter((row) => row.job.status === "running").length);
}

/** Supervised background processes this workspace's session reported, oldest first. */
export function activityDaemons(): readonly DaemonInfo[] {
	const workspaceId = state.currentWorkspaceId;
	return [...state.daemons.values()]
		.filter((d) => isLiveDaemon(d) && d.reportedBy?.includes(workspaceId) === true)
		.sort((a, b) => a.startedAt - b.startedAt);
}

/** Daemon states that still count as active; a `stopping` process is on its way out. */
const ACTIVE_DAEMON_STATES = new Set(["starting", "running", "ready", "restarting"]);

export function daemonsSummary(): ActivitySummary {
	const daemons = activityDaemons();
	return summarize(daemons.length, daemons.filter((d) => ACTIVE_DAEMON_STATES.has(d.state)).length);
}

export function todosSummary(): TodoSummary {
	const tasks = state.todoPhases.flatMap((phase) => phase.tasks);
	const done = tasks.filter((t) => t.status === "completed" || t.status === "abandoned").length;
	return { total: tasks.length, done, settled: tasks.length > 0 && done === tasks.length };
}
