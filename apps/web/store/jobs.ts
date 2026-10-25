import { createSignal } from "solid-js";
import type {
	JobDetailDto,
	JobDto,
	JobStatus,
	JobTreeDto,
	JobTreeRowDto,
} from "#lib/wire/protocol";
import { setState, state } from "../state";
import { call } from "./transport";

/**
 * Background-jobs domain: the attached session's job tree,
 * the selected job's inspection, and the cancel of the session's own jobs.
 *
 * The sheet polls while it is open. The `job_widgets` frame carries only the running
 * count and widget glances, not the tree or a job's detail, and the SDK announces no
 * job status changes. `getJobTree`/`getJobDetail` are read-only calls that never
 * trigger a state broadcast, so a short poll costs one small answer per tick.
 *
 * Every answer is stamped with the session it was asked of and dropped when
 * the attached session changed meanwhile, as in `store/plugins.ts`.
 */

/** Poll period while the sheet is open (the TUI redraws its sheet every 250 ms; a browser round trip does not need to). */
export const JOBS_POLL_MS = 2000;

interface TreeSnapshot {
	workspaceId: string;
	/** Null when the session has no async job manager. */
	tree: JobTreeDto | null;
}

interface DetailSnapshot {
	workspaceId: string;
	jobId: string;
	/** Null once the session no longer lists the job. */
	detail: JobDetailDto | null;
}

const [snapshot, setSnapshot] = createSignal<TreeSnapshot | undefined>(undefined);
const [detailSnapshot, setDetailSnapshot] = createSignal<DetailSnapshot | undefined>(undefined);
const [selectedId, setSelectedId] = createSignal<string | null>(null);
const [cancelling, setCancelling] = createSignal<string | null>(null);
const [error, setError] = createSignal<string | null>(null);
const [cancelError, setCancelError] = createSignal<string | null>(null);

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The tree of the session attached now; an answer for a session left behind never shows. */
const currentTree = (): TreeSnapshot | undefined => {
	const current = snapshot();
	return current?.workspaceId === state.currentWorkspaceId ? current : undefined;
};

/** `loading` until the first answer, `unavailable` when the session runs no async jobs, else `ready`. */
export const jobsView = (): "loading" | "unavailable" | "ready" => {
	const current = currentTree();
	if (current === undefined) return "loading";
	return current.tree === null ? "unavailable" : "ready";
};

export const jobRows = (): JobTreeRowDto[] => currentTree()?.tree?.rows ?? [];
export const jobsError = error;
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
 * Bumped on every selection change. A tree requested before a job was selected cannot say the job is
 * gone (it may have started after that request), so only a tree asked for under the current selection
 * may drop it.
 */
let selectionStamp = 0;

let refreshing: Promise<void> | undefined;

/** Reload the tree and the selected job's detail; a refresh already in flight is joined, never stacked. */
export function refreshJobs(): Promise<void> {
	refreshing ??= (async () => {
		const workspaceId = state.currentWorkspaceId;
		const stamp = selectionStamp;
		try {
			const tree = (await call("getJobTree", [])) as JobTreeDto | null;
			if (workspaceId !== state.currentWorkspaceId) return;
			setSnapshot({ workspaceId, tree });
			setError(null);
			const jobId = selectedId();
			if (jobId === null) return;
			if (selectedJob() === undefined) {
				// The row left the list (evicted after its retention window); a tree asked for before the
				// selection says nothing, so the next poll decides.
				if (stamp === selectionStamp) setSelectedId(null);
				return;
			}
			await loadDetail(workspaceId, jobId);
		} catch (err) {
			if (workspaceId === state.currentWorkspaceId) setError(message(err));
		} finally {
			refreshing = undefined;
		}
	})();
	return refreshing;
}

/** Select a job row (or none) and fetch its inspection at once. */
export function selectJob(jobId: string | null): void {
	if (jobId === selectedId()) return;
	selectionStamp++;
	setSelectedId(jobId);
	setDetailSnapshot(undefined);
	if (jobId === null) return;
	const workspaceId = state.currentWorkspaceId;
	loadDetail(workspaceId, jobId).catch((err: unknown) => {
		if (workspaceId === state.currentWorkspaceId) setError(message(err));
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

/** Poll while the sheet is open: one refresh now, then one per period, skipped while the page is hidden. Returns the stop function. */
export function startJobsPolling(): () => void {
	void refreshJobs();
	const timer = setInterval(() => {
		if (!document.hidden) void refreshJobs();
	}, JOBS_POLL_MS);
	return () => {
		clearInterval(timer);
		setSnapshot(undefined);
		setSelectedId(null);
		setDetailSnapshot(undefined);
		setError(null);
		setCancelError(null);
	};
}
