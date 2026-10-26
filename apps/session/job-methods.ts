/**
 * Background-job RPCs for the web's Activities jobs surfaces: the SDK's job tree
 * of the attached session and its subagents, one job's inspection, and the
 * cancel the TUI's jobs sheet offers on the session's own jobs only.
 *
 * `getJobTree` and `getJobDetail` change nothing (READ_ONLY_METHODS). The tree
 * goes out as rows in the SDK's display order, built by the SDK's own
 * `buildJobTree`, so the browser keeps no second copy of the nesting and
 * "busiest branch first" rules.
 */

import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AsyncJobSnapshotItem } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { buildJobTree } from "@oh-my-pi/pi-tui/overlays/job-tree";
import { glanceJobWidgetView, parseJobWidgetView } from "#lib/wire/job-widget";
import type {
	JobCancelResultDto,
	JobDetailDto,
	JobDto,
	JobTreeDto,
	JobTreeRowDto,
	WireJobWidgetView,
} from "#lib/wire/protocol";
import type { SessionEntry } from "./session-entry";

type JobMethod = (entry: SessionEntry, args: unknown[]) => Promise<unknown>;

/** Last characters of a job's output kept on the wire; a poll must stay small however chatty the job. */
export const JOB_OUTPUT_TAIL_CHARS = 16_000;

/** Settled jobs listed beside the running ones when the caller names no limit (the SDK's own default). */
const DEFAULT_RECENT_LIMIT = 10;
const MAX_RECENT_LIMIT = 50;

function refuse(message: string): never {
	throw Object.assign(new Error(message), { code: "not_eligible" });
}

function jobId(args: unknown[]): string {
	const id = args[0];
	if (typeof id !== "string" || id.length === 0) throw new Error("job id required");
	return id;
}

function recentLimit(args: unknown[]): number {
	const value = (args[0] as { recentLimit?: unknown } | undefined)?.recentLimit;
	if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RECENT_LIMIT;
	return Math.min(MAX_RECENT_LIMIT, Math.max(0, Math.floor(value)));
}

/** The session registered the job itself: the SDK's `cancelAsyncJob` scope (every job when the session has no agent id). */
function isOwn(item: AsyncJobSnapshotItem, rootId: string | undefined): boolean {
	return rootId === undefined || item.ownerId === rootId;
}

function jobDto(item: AsyncJobSnapshotItem, rootId: string | undefined): JobDto {
	return {
		id: item.id,
		type: item.type,
		status: item.status,
		label: item.label,
		startTime: item.startTime,
		...(item.endTime === undefined ? {} : { endTime: item.endTime }),
		...(item.agentId === undefined ? {} : { agentId: item.agentId }),
		...(item.ownerId === undefined ? {} : { ownerId: item.ownerId }),
		own: isOwn(item, rootId),
	};
}

/**
 * A running job's widget view as the wire carries it, cut to a glance for a row.
 * Reading it marks the widget shown, which lets the `widget` model role write its
 * spec. Absent when `async.widgets` is off (the registry's `enabled()` is read per
 * call), the job has no widget inputs, or the job is gone.
 */
function rowWidget(session: AgentSession, id: string): WireJobWidgetView | undefined {
	const manager = session.asyncJobManager;
	const job = manager?.getJob(id);
	const view = job ? parseJobWidgetView(manager?.widgets?.view(job)) : undefined;
	return view ? glanceJobWidgetView(view) : undefined;
}

/** The session's job tree as wire rows; null when the session has no async job manager. */
export function jobTree(session: AgentSession, limit = DEFAULT_RECENT_LIMIT): JobTreeDto | null {
	const tree = session.getAsyncJobTree({ recentLimit: limit });
	if (!tree) return null;
	const rows: JobTreeRowDto[] = buildJobTree(
		[...tree.running, ...tree.recent],
		tree.agents,
		tree.rootId,
	).map((row) => {
		const place = { depth: row.depth, rails: [...row.rails], last: row.last, parent: row.parent };
		if (row.kind !== "job") return { ...place, kind: "agent", agent: row.agent };
		const widget = row.job.status === "running" ? rowWidget(session, row.job.id) : undefined;
		return {
			...place,
			kind: "job",
			job: jobDto(row.job, tree.rootId),
			...(row.agent ? { agent: row.agent } : {}),
			...(widget ? { widget } : {}),
		};
	});
	return { ...(tree.rootId === undefined ? {} : { rootId: tree.rootId }), rows };
}

/** One job's inspection with the output cut to its tail; null once the job is unknown, outside the tree, or evicted. */
export function jobDetail(session: AgentSession, id: string): JobDetailDto | null {
	const inspection = session.inspectAsyncJob(id);
	if (!inspection) return null;
	const { output } = inspection;
	const widget = parseJobWidgetView(inspection.widget);
	const truncated = output !== undefined && output.length > JOB_OUTPUT_TAIL_CHARS;
	return {
		...(inspection.command === undefined ? {} : { command: inspection.command }),
		...(inspection.cwd === undefined ? {} : { cwd: inspection.cwd }),
		pids: [...inspection.pids],
		...(inspection.exitCode === undefined ? {} : { exitCode: inspection.exitCode }),
		...(output === undefined
			? {}
			: { output: truncated ? output.slice(-JOB_OUTPUT_TAIL_CHARS) : output }),
		...(truncated ? { outputTruncated: true } : {}),
		...(inspection.artifactId === undefined ? {} : { artifactId: inspection.artifactId }),
		...(widget ? { widget } : {}),
	};
}

/**
 * Cancel a running job the session registered itself. A subagent's job is
 * refused (`not_eligible`), as is an id outside the tree; the SDK's
 * `cancelAsyncJob` then enforces the same owner scope and reports whether the
 * job was still running.
 */
export function cancelJob(session: AgentSession, id: string): JobCancelResultDto {
	const tree = session.getAsyncJobTree({ recentLimit: Number.POSITIVE_INFINITY });
	if (!tree) refuse("Background jobs are unavailable in this session");
	const item = [...tree.running, ...tree.recent].find((job) => job.id === id);
	if (!item) refuse(`No background job ${id} in this session`);
	if (!isOwn(item, tree.rootId))
		refuse(
			`Job ${id} belongs to ${item.ownerId ?? "another agent"}; only this session's own jobs can be cancelled`,
		);
	return { cancelled: session.cancelAsyncJob(id) };
}

export function createJobMethods(): Record<string, JobMethod> {
	return {
		getJobTree: async (entry, args) => jobTree(entry.session, recentLimit(args)),
		getJobDetail: async (entry, args) => jobDetail(entry.session, jobId(args)),
		cancelJob: async (entry, args) => cancelJob(entry.session, jobId(args)),
	};
}
