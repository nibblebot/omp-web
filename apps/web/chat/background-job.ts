import { isRecord } from "#lib/wire/type-guards";
import type { ChatItem, ToolItem, ToolStatus } from "../state";

/**
 * A bash, eval or task call that returned while its job keeps running (the SDK's
 * `details.async`): the card stays parked on the job, takes its later output and
 * settles with its last state, as the TUI's parked cards do (pi-tui
 * `parksAsBackground` / `settleWithJobFrame`). Pure, so the rules test without a DOM.
 */

/** A background job's state as the SDK reports it (`details.async.state`). */
export type AsyncJobState = "running" | "completed" | "failed" | "cancelled";
/** A job's last state. */
export type SettledJobState = Exclude<AsyncJobState, "running">;

/** The job frame a result's details carry. */
export interface AsyncJobRef {
	state: AsyncJobState;
	jobId: string;
	type: string;
}

/** What a tool card remembers of the job it handed its card to (`ToolItem.background`). */
export interface BackgroundJob {
	/** The job the call started: a task call's primary job. */
	jobId: string;
	type: string;
	state: AsyncJobState;
	/** Every job the call waits on: a task with several detached spawns has one per spawn. */
	jobIds: string[];
	/** Epoch ms the running clock counts from: when the call returned, or its result's stamp on a reload. */
	startedAt: number;
	/** How long the job ran, once it settled and the run time is known. */
	durationMs?: number;
	/** Exit code of a failed command. */
	exitCode?: number;
	/** Jobs of `jobIds` already known settled, while the call still waits on the rest. */
	settled?: Partial<Record<string, SettledJobState>>;
}

const JOB_STATES: Record<string, AsyncJobState> = {
	running: "running",
	completed: "completed",
	failed: "failed",
	cancelled: "cancelled",
};

/** Tools whose returned call hands its card to the job it started. */
const BACKGROUND_TOOLS: Record<string, true> = { bash: true, eval: true, task: true };

/** Card status a settled job leaves: a cancelled job keeps its output and reads as interrupted. */
const SETTLED_STATUS: Record<SettledJobState, ToolStatus> = {
	completed: "done",
	failed: "error",
	cancelled: "interrupted",
};

/** The job frame of a result's details (`details.async`), when it is a well-formed one. */
export function asyncJobOf(details: unknown): AsyncJobRef | undefined {
	if (!isRecord(details) || !isRecord(details.async)) return undefined;
	const { state, jobId, type } = details.async;
	const known = typeof state === "string" ? JOB_STATES[state] : undefined;
	if (known === undefined || typeof jobId !== "string" || jobId === "") return undefined;
	return { state: known, jobId, type: typeof type === "string" ? type : "" };
}

/** Ids of the subagents a task result's `progress` lists, optionally only those whose run is still open. */
function progressIds(details: unknown, openOnly: boolean): string[] {
	if (!isRecord(details) || !Array.isArray(details.progress)) return [];
	const ids: string[] = [];
	for (const entry of details.progress) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") continue;
		if (openOnly && entry.status !== "pending" && entry.status !== "running") continue;
		ids.push(entry.id);
	}
	return ids;
}

/**
 * The origin card of a job: the tool item whose result's `details.async.jobId` is
 * `jobId`. A task job also matches by the id of the subagent it runs.
 */
export function originCardOf(items: readonly ChatItem[], jobId: string): ToolItem | undefined {
	for (const item of items) {
		if (item.kind !== "tool") continue;
		if (asyncJobOf(item.details)?.jobId === jobId) return item;
		if (item.name === "task" && progressIds(item.details, false).includes(jobId)) return item;
	}
	return undefined;
}

/**
 * The background job a returned call stays parked on: set when the call's result
 * says its job still runs (a bash, eval or task call), undefined for any other result.
 * `startedAt` is when the call returned.
 */
export function backgroundOf(
	toolName: string,
	details: unknown,
	startedAt: number,
): BackgroundJob | undefined {
	const job = asyncJobOf(details);
	if (job?.state !== "running" || BACKGROUND_TOOLS[toolName] !== true) return undefined;
	const jobIds = [job.jobId];
	if (toolName === "task") {
		for (const id of progressIds(details, true)) if (!jobIds.includes(id)) jobIds.push(id);
	}
	return { jobId: job.jobId, type: job.type || toolName, state: "running", jobIds, startedAt };
}

/** Whether the card's job still runs. */
export function isBackgroundRunning(item: ToolItem): boolean {
	return item.background?.state === "running";
}

/** The status a card shows: running while its job does, else the call's settled status. */
export function effectiveStatus(item: ToolItem): ToolStatus {
	return isBackgroundRunning(item) ? "running" : item.status;
}

/** A job's last state, as one frame or delivery reported it. */
export interface JobOutcome {
	state: SettledJobState;
	exitCode?: number;
	durationMs?: number;
}

/**
 * Settle a parked card with its job's last state, in place: completed is done, failed
 * is an error (with its exit code), cancelled is interrupted and keeps the output the
 * card got to. Nothing changes for a card that is not parked on a running job.
 */
export function settleBackground(item: ToolItem, outcome: JobOutcome): boolean {
	const job = item.background;
	if (job === undefined || job.state !== "running") return false;
	job.state = outcome.state;
	if (outcome.exitCode !== undefined) job.exitCode = outcome.exitCode;
	if (outcome.durationMs !== undefined) job.durationMs = outcome.durationMs;
	item.status = SETTLED_STATUS[outcome.state];
	return true;
}

/** Whole call's state from its jobs' states: failed over cancelled over completed; undefined while any job's state is unknown. */
export function aggregateJobStates(
	states: readonly (SettledJobState | undefined)[],
): SettledJobState | undefined {
	if (states.length === 0) return undefined;
	let result: SettledJobState = "completed";
	for (const state of states) {
		if (state === undefined) return undefined;
		if (state === "failed") result = "failed";
		else if (state === "cancelled" && result === "completed") result = "cancelled";
	}
	return result;
}

/** One job of an `async-result` delivery. */
export interface AsyncResultJob {
	jobId: string;
	/** The subagent id of a task job, which the delivery's job id may differ from. */
	agentId?: string;
	state: SettledJobState;
	durationMs?: number;
}

/** `customType` of the delivery the session injects when background jobs settle. */
export const ASYNC_RESULT_TYPE = "async-result";

/** The settled jobs an `async-result` custom message reports (`details.jobs`); empty for any other message. */
export function asyncResultJobsOf(message: unknown): AsyncResultJob[] {
	if (!isRecord(message) || message.role !== "custom" || message.customType !== ASYNC_RESULT_TYPE)
		return [];
	const details = message.details;
	if (!isRecord(details) || !Array.isArray(details.jobs)) return [];
	const jobs: AsyncResultJob[] = [];
	for (const raw of details.jobs) {
		if (!isRecord(raw) || typeof raw.jobId !== "string") continue;
		const state = typeof raw.status === "string" ? JOB_STATES[raw.status] : undefined;
		if (state === undefined || state === "running") continue;
		jobs.push({
			jobId: raw.jobId,
			state,
			...(typeof raw.agentId === "string" && raw.agentId !== "" ? { agentId: raw.agentId } : {}),
			...(typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)
				? { durationMs: Math.max(0, raw.durationMs) }
				: {}),
		});
	}
	return jobs;
}

/**
 * Settle the parked cards among `items` that `jobs` finish: each card records the
 * jobs of its call that settled and takes its last state once all of them did.
 * Mutates in place; returns the cards whose record changed.
 */
export function applyAsyncResults(
	items: Iterable<ToolItem>,
	jobs: readonly AsyncResultJob[],
): ToolItem[] {
	const changed: ToolItem[] = [];
	for (const item of items) {
		const parked = item.background;
		if (parked === undefined || parked.state !== "running") continue;
		const settled = { ...parked.settled };
		let duration = parked.durationMs;
		let touched = false;
		for (const job of jobs) {
			for (const id of parked.jobIds) {
				if (id !== job.jobId && id !== job.agentId) continue;
				settled[id] = job.state;
				duration = Math.max(duration ?? 0, job.durationMs ?? 0);
				touched = true;
			}
		}
		if (!touched) continue;
		parked.settled = settled;
		const state = aggregateJobStates(parked.jobIds.map((id) => settled[id]));
		if (state !== undefined) {
			settleBackground(item, {
				state,
				...(duration !== undefined ? { durationMs: duration } : {}),
			});
		}
		changed.push(item);
	}
	return changed;
}

/** The parked cards among `items` whose job still runs, as far as the transcript knows. */
export function runningBackgroundCards(items: Iterable<ChatItem>): ToolItem[] {
	const cards: ToolItem[] = [];
	for (const item of items) if (item.kind === "tool" && isBackgroundRunning(item)) cards.push(item);
	return cards;
}

/** A job of the session's job list, as far as reconciling a reloaded card needs it (`JobDto`). */
export interface ListedJob {
	id: string;
	agentId?: string;
	status: AsyncJobState;
	startTime: number;
	endTime?: number;
}

/**
 * A reloaded transcript has no frames, only the start result and the deliveries that
 * already arrived: look the cards still parked on a running job up in the session's job
 * list. A job that settled settles its card; one still running keeps it parked; a call
 * whose jobs are gone from the list (evicted, or settled with the delivery suppressed)
 * has an unknowable outcome, so it keeps its start text as a plain done card and never a
 * made-up state. `jobs` is undefined when the list is unavailable: nothing is known then either.
 * Mutates in place; returns the cards that changed.
 */
export function reconcileBackgroundJobs(
	items: Iterable<ToolItem>,
	jobs: readonly ListedJob[] | undefined,
): ToolItem[] {
	const changed: ToolItem[] = [];
	for (const item of items) {
		const parked = item.background;
		if (parked === undefined || parked.state !== "running") continue;
		const known = parked.jobIds.map((id) =>
			jobs?.find((job) => job.id === id || job.agentId === id),
		);
		if (known.some((job) => job?.status === "running")) continue;
		const state = aggregateJobStates(
			known.map((job, i) =>
				job === undefined
					? parked.settled?.[parked.jobIds[i]!]
					: job.status === "running"
						? undefined
						: job.status,
			),
		);
		if (state === undefined) {
			item.background = undefined;
		} else {
			const ran = known.flatMap((job) =>
				job?.endTime === undefined ? [] : [Math.max(0, job.endTime - job.startTime)],
			);
			settleBackground(item, {
				state,
				...(ran.length > 0 ? { durationMs: Math.max(...ran) } : {}),
			});
		}
		changed.push(item);
	}
	return changed;
}
