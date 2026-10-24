/**
 * What a `wait` tool call's `details` give its card: the watched jobs as tiles
 * (id, type, status, label, run time, a subagent's stage and completion
 * estimate), plus running agents with no job row. The SDK's `CoordinationDetails`
 * (pi-tui tools/wait.ts) also carries each job's widget and result text. A
 * settled call's tiles draw the widgets (`widgets`, cut by `parseJobWidgetView`);
 * the live frame never carries them. The result text is not read. Pure, so the
 * parsing stays testable without a DOM.
 */
import { parseJobWidgetView } from "#lib/wire/job-widget";
import type { WireJobWidgetView, WireWaitJob } from "#lib/wire/protocol";
import { slimWaitJobs } from "#lib/wire/tool-live";
import { isRecord } from "#lib/wire/type-guards";
import type { ToolItem } from "../state";

/** Tiles a wait card shows before it counts the rest (the SDK TUI's `TILES_SHOWN`). */
export const WAIT_TILES_SHOWN = 9;

/** A running agent that has no job row in the result (a peer-woken or revived subagent). */
export interface WaitAgent {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry. */
	activity?: string;
	/** Time since the agent registered, ms. */
	ageMs: number;
	/** False when no attached session corroborates the running claim. */
	live: boolean;
}

/** The parsed card input of one wait call. */
export interface WaitView {
	/** Each settled job's widget view by job id (only jobs whose widget is a view); empty for a running call. */
	widgets: ReadonlyMap<string, WireJobWidgetView>;
	jobs: WireWaitJob[];
	agents: WaitAgent[];
	/** Whether the jobs are a running call's live frame (their clocks advance from `at`). */
	live: boolean;
	/** Epoch ms the live frame arrived; clocks of running jobs advance from it. */
	at?: number;
	/** The wait was cut short by steering, a peer message or a completion notice. */
	interrupted: boolean;
}

const JOB_ORDER: Record<WireWaitJob["status"], number> = {
	running: 0,
	failed: 1,
	cancelled: 2,
	completed: 3,
};

/** Running jobs first, then failed, cancelled, completed; the longest-running first within a status. */
export function sortWaitJobs(jobs: readonly WireWaitJob[]): WireWaitJob[] {
	return [...jobs].sort(
		(a, b) => JOB_ORDER[a.status] - JOB_ORDER[b.status] || b.durationMs - a.durationMs,
	);
}

function parseAgents(details: unknown): WaitAgent[] {
	if (!isRecord(details) || !Array.isArray(details.agents)) return [];
	const agents: WaitAgent[] = [];
	for (const raw of details.agents) {
		if (!isRecord(raw) || typeof raw.id !== "string") continue;
		agents.push({
			id: raw.id,
			...(typeof raw.parentId === "string" ? { parentId: raw.parentId } : {}),
			...(typeof raw.activity === "string" && raw.activity !== ""
				? { activity: raw.activity }
				: {}),
			ageMs: typeof raw.ageMs === "number" && Number.isFinite(raw.ageMs) ? raw.ageMs : 0,
			live: raw.live === true,
		});
	}
	return agents;
}

/** Each job's widget of a settled call's details (`jobs[].widget`), by job id. */
function parseWidgets(details: unknown): Map<string, WireJobWidgetView> {
	const widgets = new Map<string, WireJobWidgetView>();
	if (!isRecord(details) || !Array.isArray(details.jobs)) return widgets;
	for (const raw of details.jobs) {
		if (!isRecord(raw) || typeof raw.id !== "string" || raw.widget === undefined) continue;
		const view = parseJobWidgetView(raw.widget);
		if (view) widgets.set(raw.id, view);
	}
	return widgets;
}

/**
 * The jobs a wait card shows: a running call's live frame, else the settled
 * details. Undefined when the call lists no job and no agent (the card then
 * shows the result text, e.g. "Nothing to wait for").
 */
export function waitViewOf(item: ToolItem): WaitView | undefined {
	const live = item.status === "running" ? item.live : undefined;
	const jobs =
		live?.kind === "wait"
			? live.jobs
			: item.status === "running"
				? []
				: (slimWaitJobs(item.details)?.jobs ?? []);
	const agents = item.status === "running" ? [] : parseAgents(item.details);
	if (jobs.length === 0 && agents.length === 0) return undefined;
	return {
		jobs: sortWaitJobs(jobs),
		widgets: item.status === "running" ? new Map() : parseWidgets(item.details),
		agents,
		live: live?.kind === "wait",
		...(live?.kind === "wait" ? { at: live.at } : {}),
		interrupted: isRecord(item.details) && item.details.interrupted === true,
	};
}

/** Run time to show for a job: a running job of a live frame keeps counting from the frame's arrival. */
export function jobElapsedMs(
	job: WireWaitJob,
	view: Pick<WaitView, "live" | "at">,
	now: number,
): number {
	return job.status === "running" && view.live && view.at !== undefined
		? job.durationMs + Math.max(0, now - view.at)
		: job.durationMs;
}

/** Counts per status, for the header summary. */
export function waitCounts(jobs: readonly WireWaitJob[]): Record<WireWaitJob["status"], number> {
	const counts = { running: 0, completed: 0, failed: 0, cancelled: 0 };
	for (const job of jobs) counts[job.status]++;
	return counts;
}

/** The header summary the SDK shows: `waiting on 2 of 3 jobs`, `3 jobs settled`, or the agents when no job. */
export function waitSummary(view: WaitView): string {
	const { jobs, agents } = view;
	const noun = jobs.length === 1 ? "job" : "jobs";
	if (jobs.length === 0) {
		return `${agents.length} running agent${agents.length === 1 ? "" : "s"}, no jobs`;
	}
	const running = waitCounts(jobs).running;
	if (running === 0) return `${jobs.length} ${noun} settled`;
	return running === jobs.length
		? `waiting on ${jobs.length} ${noun}`
		: `waiting on ${running} of ${jobs.length} ${noun}`;
}

/** A tile's title: a subagent goes by its id, any other job by the first line of what it runs. */
export function jobTitle(job: WireWaitJob): string {
	if (job.type === "task") return job.id;
	return job.label.split(/\r?\n/, 1)[0]?.trim() || job.id;
}
