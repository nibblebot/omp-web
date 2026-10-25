import {
	createMemo,
	createSignal,
	For,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
	type Component,
} from "solid-js";
import type { JobTreeRowDto } from "#lib/wire/protocol";
import {
	cancellingJobId,
	cancelOwnJob,
	jobCancelError,
	jobList,
	jobRowKey,
	jobRows,
	jobsError,
	jobsView,
	refreshJobs,
	selectedJob,
	selectedJobDetail,
	selectedJobId,
	selectJob,
	JOBS_POLL_MS,
	startJobsPolling,
} from "../../store/jobs";
import { Modal } from "../ui/Modal";
import { JobDetail } from "./JobDetail";
import { JobRow } from "./JobRow";

/**
 * Background jobs sheet: the session's jobs and its subagents' as a tree
 * (busiest branches first, the session's SDK order), with the selected job's
 * detail underneath. Polls while it is open (store/jobs.ts); Cancel appears
 * only on the session's own running jobs.
 */
export const JobsSheet: Component<{ onClose: () => void }> = (props) => {
	const [now, setNow] = createSignal(Date.now());
	onMount(() => {
		const stop = startJobsPolling();
		const clock = setInterval(() => setNow(Date.now()), 1000);
		onCleanup(() => {
			stop();
			clearInterval(clock);
		});
	});
	const running = () => jobList().filter((job) => job.status === "running").length;
	const settled = () => jobList().length - running();
	// Rows render by key, not by object: every poll hands over new row objects, and remounting the list
	// would drop focus and a pending Cancel confirm on each tick.
	const byKey = createMemo(() => new Map(jobRows().map((row) => [jobRowKey(row), row])));
	const keys = createMemo(() => jobRows().map(jobRowKey));
	return (
		<Modal title="Background jobs" variant="sheet" class="jobs-sheet" onClose={props.onClose}>
			<div class="jobs-body">
				<div class="jobs-head">
					<span class="jobs-summary">
						{running()} running · {settled()} recent
					</span>
					<span class="jobs-poll-hint">updates every {JOBS_POLL_MS / 1000}s</span>
					<button type="button" class="jobs-refresh" onClick={() => void refreshJobs()}>
						refresh
					</button>
				</div>
				<Show when={jobsError()}>
					{(err) => (
						<div class="jobs-error" role="alert">
							{err()}
						</div>
					)}
				</Show>
				<Show when={jobCancelError()}>
					{(err) => (
						<div class="jobs-error" role="alert">
							{err()}
						</div>
					)}
				</Show>
				<div class="jobs-split" data-detail={selectedJob() === undefined ? undefined : ""}>
					<Switch>
						<Match when={jobsView() === "loading"}>
							<p class="jobs-note">loading jobs…</p>
						</Match>
						<Match when={jobsView() === "unavailable"}>
							<p class="jobs-note">Background jobs are unavailable in this session.</p>
						</Match>
						<Match when={jobRows().length === 0}>
							<p class="jobs-note">
								No background jobs. Long-running commands and subagents the agent starts in the
								background appear here while they run, and for a few minutes after.
							</p>
						</Match>
						<Match when={true}>
							<ol class="jobs-tree" aria-label="Background jobs">
								<For each={keys()}>
									{(key) => {
										let last = byKey().get(key) as JobTreeRowDto;
										const row = () => (last = byKey().get(key) ?? last);
										const jobId = () => {
											const current = row();
											return current.kind === "job" ? current.job.id : undefined;
										};
										return (
											<li class="jobs-tree-item">
												<JobRow
													row={row()}
													now={now()}
													selected={jobId() !== undefined && jobId() === selectedJobId()}
													cancelling={jobId() !== undefined && jobId() === cancellingJobId()}
													onSelect={selectJob}
													onCancel={(id) => void cancelOwnJob(id)}
												/>
											</li>
										);
									}}
								</For>
							</ol>
						</Match>
					</Switch>
					<Show when={selectedJob()}>
						{(job) => <JobDetail job={job()} detail={selectedJobDetail()} now={now()} />}
					</Show>
				</div>
			</div>
		</Modal>
	);
};
