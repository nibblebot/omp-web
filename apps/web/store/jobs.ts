import { createSignal, untrack } from "solid-js";
import type { JobDetailDto, JobDto, JobStatus } from "#lib/wire/protocol";
import { state } from "../state";
import { jobPollError, jobTreeRows, onJobTreeAnswer, refreshJobTree } from "./job-poll";
import { call } from "./transport";

/**
 * Background-jobs domain of the Activities panel: the inspection of the jobs the panel has open (an
 * accordion body, the detail view) and the cancel of the session's own jobs, over the job tree the shared
 * poll (`store/job-poll.ts`) keeps. Which jobs are open, filtered or in detail is `store/activities.ts`.
 *
 * `getJobDetail` is a read-only call that never triggers a state broadcast. A job's detail loads when a
 * surface starts watching it and reloads with each tree answer while the job runs (and once more after it
 * settles, for its final output).
 *
 * Every answer is stamped with the workspace it was asked of and dropped when the attached workspace
 * changed meanwhile, as in `store/plugins.ts`.
 */

interface DetailSnapshot {
	workspaceId: string;
	/** Null once the session no longer lists the job. */
	detail: JobDetailDto | null;
	/** The job was running when this was asked, so a later answer may differ even after it settled. */
	askedRunning: boolean;
}

const [details, setDetails] = createSignal<ReadonlyMap<string, DetailSnapshot>>(new Map());
const [cancelling, setCancelling] = createSignal<string | null>(null);
const [detailError, setDetailError] = createSignal<string | null>(null);
const [cancelError, setCancelError] = createSignal<string | null>(null);

/** Surfaces watching each job's detail. */
const watchers = new Map<string, number>();
/** Ordinal of the newest detail request per job: an older answer arriving late is dropped. */
const requests = new Map<string, number>();
let requested = 0;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Why the tree or a watched job's detail could not load; cleared by the next good answer. */
export const jobsError = (): string | null => jobPollError() ?? detailError();
/** Why the last Cancel failed (a refusal, a lost connection); cleared by the next Cancel. */
export const jobCancelError = cancelError;
export const cancellingJobId = cancelling;

/** A job's status as the panel names it. */
export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
	running: "running",
	completed: "done",
	failed: "failed",
	cancelled: "cancelled",
};

/** What a job is called: the purpose the model gave it, else its label (the command or task description). */
export const jobTitle = (job: JobDto): string => job.intent ?? job.label;

/** Run time of a job: counting up while it runs, frozen once it settled, unknown for a cancelled job whose run has not ended yet. */
export function jobElapsedMs(job: JobDto, now: number): number | undefined {
	if (job.status === "running") return Math.max(0, now - job.startTime);
	return job.endTime === undefined ? undefined : Math.max(0, job.endTime - job.startTime);
}

const statusOf = (jobId: string): JobStatus | undefined => {
	for (const row of jobTreeRows())
		if (row.kind === "job" && row.job.id === jobId) return row.job.status;
	return undefined;
};

/** A watched job's inspection: undefined while it loads, null once the session no longer lists the job. */
export function jobDetailOf(jobId: string): JobDetailDto | null | undefined {
	const snapshot = details().get(jobId);
	return snapshot?.workspaceId === state.currentWorkspaceId ? snapshot.detail : undefined;
}

async function loadDetail(jobId: string): Promise<void> {
	const workspaceId = state.currentWorkspaceId;
	const askedRunning = untrack(() => statusOf(jobId)) === "running";
	const ordinal = ++requested;
	requests.set(jobId, ordinal);
	try {
		const detail = (await call("getJobDetail", [jobId])) as JobDetailDto | null | undefined;
		if (workspaceId !== state.currentWorkspaceId || requests.get(jobId) !== ordinal) return;
		setDetails((prev) =>
			new Map(prev).set(jobId, { workspaceId, detail: detail ?? null, askedRunning }),
		);
		setDetailError(null);
	} catch (err) {
		if (workspaceId === state.currentWorkspaceId && requests.get(jobId) === ordinal)
			setDetailError(message(err));
	}
}

/** A tree answer arrived: reload each watched job's detail that can have changed. */
async function reloadWatched(): Promise<void> {
	const stale = [...watchers.keys()].filter((jobId) => {
		const status = statusOf(jobId);
		// A job the tree does not list keeps what it has: a poll asked before it started cannot say it is gone.
		if (status === undefined) return false;
		const snapshot = details().get(jobId);
		return (
			snapshot === undefined ||
			snapshot.workspaceId !== state.currentWorkspaceId ||
			snapshot.detail === null ||
			status === "running" ||
			snapshot.askedRunning
		);
	});
	await Promise.all(stale.map(loadDetail));
}
onJobTreeAnswer(() => untrack(reloadWatched));

/**
 * Keep one job's detail loaded (`jobDetailOf`) until the returned release runs: fetched at once, then
 * refreshed with the tree. Several surfaces may watch the same job; the last release forgets it.
 * Call inside a component lifetime.
 */
export function watchJobDetail(jobId: string): () => void {
	const count = watchers.get(jobId) ?? 0;
	watchers.set(jobId, count + 1);
	if (count === 0) void loadDetail(jobId);
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		const left = (watchers.get(jobId) ?? 1) - 1;
		if (left > 0) {
			watchers.set(jobId, left);
			return;
		}
		watchers.delete(jobId);
		requests.delete(jobId);
		setDetails((prev) => {
			const next = new Map(prev);
			next.delete(jobId);
			return next;
		});
		if (watchers.size === 0) setDetailError(null);
	};
}

/**
 * One-off inspection of a job of the attached session, for a surface that does not watch it. Resolves
 * null when the session no longer lists the job, the call fails, or the session changed meanwhile.
 */
export async function fetchJobDetail(jobId: string): Promise<JobDetailDto | null> {
	const workspaceId = state.currentWorkspaceId;
	try {
		const detail = (await call("getJobDetail", [jobId])) as JobDetailDto | null | undefined;
		return workspaceId === state.currentWorkspaceId ? (detail ?? null) : null;
	} catch {
		return null;
	}
}

/** Cancel one of the session's own running jobs; the session refuses any other. The tree reloads either way, from a request asked after the cancel. */
export async function cancelOwnJob(jobId: string): Promise<void> {
	const workspaceId = state.currentWorkspaceId;
	setCancelling(jobId);
	setCancelError(null);
	try {
		await call("cancelJob", [jobId]);
	} catch (err) {
		if (workspaceId === state.currentWorkspaceId) setCancelError(message(err));
	} finally {
		setCancelling(null);
	}
	await refreshJobTree({ fresh: true });
}

/** Forget a Cancel refusal once the surface that showed it is gone. */
export function clearJobCancelError(): void {
	setCancelError(null);
}
