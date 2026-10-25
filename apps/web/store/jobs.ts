import { createSignal, untrack } from "solid-js";
import type { JobDetailDto, JobDto, JobStatus, JobTreeRowDto } from "#lib/wire/protocol";
import { setState, state } from "../state";
import {
	acquireJobPollFocus,
	JOB_POLL_FOCUSED_MS,
	jobPollCount,
	jobPollError,
	jobPollView,
	jobTreeRows,
	onJobTreeAnswer,
	refreshJobTree,
} from "./job-poll";
import { call } from "./transport";

/**
 * Background-jobs domain: the selected job's inspection and the cancel of the session's own jobs, over
 * the job tree the shared poll (`store/job-poll.ts`) keeps.
 *
 * The sheet holds the poll's faster period while it is open. `getJobDetail` is a read-only call that
 * never triggers a state broadcast; the selected job's detail reloads with each tree answer.
 *
 * Every answer is stamped with the session it was asked of and dropped when the attached session
 * changed meanwhile, as in `store/plugins.ts`.
 */

/** Poll period while the sheet is open. */
export const JOBS_POLL_MS = JOB_POLL_FOCUSED_MS;

interface DetailSnapshot {
	workspaceId: string;
	jobId: string;
	/** Null once the session no longer lists the job. */
	detail: JobDetailDto | null;
}

const [detailSnapshot, setDetailSnapshot] = createSignal<DetailSnapshot | undefined>(undefined);
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [cancelling, setCancelling] = createSignal<string | null>(null);
const [detailError, setDetailError] = createSignal<string | null>(null);
const [cancelError, setCancelError] = createSignal<string | null>(null);

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `loading` until the first answer, `unavailable` when the session runs no async jobs, else `ready`. */
export const jobsView = (): "loading" | "unavailable" | "ready" => {
	const phase = jobPollView().phase;
	return phase === "unavailable" || phase === "ready" ? phase : "loading";
};

export const jobRows = (): JobTreeRowDto[] => [...jobTreeRows()];
/** Why the tree or the selected job's detail could not load; cleared by the next good answer. */
export const jobsError = (): string | null => jobPollError() ?? detailError();
/** Why the last Cancel failed (a refusal, a lost connection); cleared by the next Cancel. */
export const jobCancelError = cancelError;
export const selectedJobId = selectedId;
export const cancellingJobId = cancelling;

/** A job's status as the sheet names it. */
export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
	running: "running",
	completed: "done",
	failed: "failed",
	cancelled: "cancelled",
};

/** Stable identity of a tree row across polls, so the list keeps its rows (and a pending Cancel confirm) instead of remounting them. */
export const jobRowKey = (row: JobTreeRowDto): string =>
	row.kind === "job" ? `job:${row.job.id}` : `agent:${row.agent.id}`;

/** Run time of a job: counting up while it runs, frozen once it settled, unknown for a cancelled job whose run has not ended yet. */
export function jobElapsedMs(job: JobDto, now: number): number | undefined {
	if (job.status === "running") return Math.max(0, now - job.startTime);
	return job.endTime === undefined ? undefined : Math.max(0, job.endTime - job.startTime);
}

/** Every job row of the tree, in display order. */
export const jobList = (): JobDto[] =>
	jobRows().flatMap((row) => (row.kind === "job" ? [row.job] : []));

export const selectedJob = (): JobDto | undefined =>
	jobList().find((job) => job.id === selectedId());

/** The selected job's inspection: undefined while it loads, null once the job is gone. */
export const selectedJobDetail = (): JobDetailDto | null | undefined => {
	const current = detailSnapshot();
	return current?.workspaceId === state.currentWorkspaceId && current.jobId === selectedId()
		? current.detail
		: undefined;
};

async function loadDetail(workspaceId: string, jobId: string): Promise<void> {
	const detail = (await call("getJobDetail", [jobId])) as JobDetailDto | null;
	if (workspaceId !== state.currentWorkspaceId || jobId !== selectedId()) return;
	setDetailSnapshot({ workspaceId, jobId, detail });
}

/**
 * The poll count when the selection last changed. A tree requested before a job was selected cannot say
 * the job is gone (it may have started after that request), so only a tree asked for after the selection
 * may drop it.
 */
let selectionPoll = 0;

/** A tree answer arrived: drop the selection when its row left the list, else reload the selected job's detail. */
async function syncSelectedJob(poll: number): Promise<void> {
	const jobId = selectedId();
	if (jobId === null) return;
	const workspaceId = state.currentWorkspaceId;
	if (selectedJob() === undefined) {
		// The row left the list (evicted after its retention window); a tree asked for before the
		// selection says nothing, so the next poll decides.
		if (poll > selectionPoll) setSelectedId(null);
		return;
	}
	try {
		await loadDetail(workspaceId, jobId);
		setDetailError(null);
	} catch (err) {
		if (workspaceId === state.currentWorkspaceId) setDetailError(message(err));
	}
}
onJobTreeAnswer((poll) => untrack(() => syncSelectedJob(poll)));

/** Reload the tree now (the shared poll; one already in flight is joined) and the selected job's detail with it. */
export const refreshJobs = refreshJobTree;

/** Select a job row (or none) and fetch its inspection at once. */
export function selectJob(jobId: string | null): void {
	if (jobId === selectedId()) return;
	selectionPoll = jobPollCount();
	setSelectedId(jobId);
	setDetailSnapshot(undefined);
	if (jobId === null) return;
	const workspaceId = state.currentWorkspaceId;
	loadDetail(workspaceId, jobId).catch((err: unknown) => {
		if (workspaceId === state.currentWorkspaceId) setDetailError(message(err));
	});
}

/**
 * Open the jobs sheet (ModalHost renders it) and, given a job, select its row: the detail loads at once
 * and the row highlights once the tree has it, whether the sheet was closed or is open already. A job the
 * tree no longer lists (evicted) leaves nothing selected.
 */
export function openJobsSheet(jobId?: string): void {
	if (jobId !== undefined) selectJob(jobId);
	setState("modal", "jobs");
}

/**
 * One-off inspection of a job of the attached session, for a surface outside the sheet. Resolves null when
 * the session no longer lists the job, the call fails, or the session changed meanwhile; never touches the
 * sheet's selection.
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

/** Cancel one of the session's own running jobs; the session refuses any other. The tree reloads either way. */
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
	await refreshJobs();
}

/** The sheet is open: hold the poll's faster period and load the tree now. Returns the stop function, which also forgets the selection and errors. */
export function startJobsPolling(): () => void {
	const release = acquireJobPollFocus();
	void refreshJobTree();
	return () => {
		release();
		setSelectedId(null);
		setDetailSnapshot(undefined);
		setDetailError(null);
		setCancelError(null);
	};
}
