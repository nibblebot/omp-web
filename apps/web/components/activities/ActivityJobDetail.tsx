import { createEffect, createMemo, onCleanup, Show, type Component } from "solid-js";
import { activityJobRows } from "../../activities/summary";
import { createNow } from "../../activities/clock";
import { acquireJobPollFocus, jobPollView } from "../../store/job-poll";
import {
	cancelOwnJob,
	cancellingJobId,
	clearJobCancelError,
	jobDetailOf,
	watchJobDetail,
} from "../../store/jobs";
import { JobDetail } from "../jobs/JobDetail";
import { JobErrors } from "./JobErrors";

/**
 * One job's detail in the Activities panel, fed by the shared job poll: the job's row for its status and the
 * inspection `getJobDetail` loads while it is open. Inline (an accordion body) the section above supplies the
 * poll's fast period and Cancel sits on the row. `standalone` is the detail view that fills the panel: it
 * holds the fast period itself, carries Cancel for the session's own running job, and shows the errors.
 */
export const ActivityJobDetail: Component<{ id: string; standalone?: boolean }> = (props) => {
	const now = createNow();
	const job = createMemo(() => activityJobRows().find((row) => row.job.id === props.id)?.job);
	createEffect(() => onCleanup(watchJobDetail(props.id)));
	createEffect(() => {
		if (props.standalone !== true) return;
		onCleanup(acquireJobPollFocus());
		onCleanup(clearJobCancelError);
	});
	return (
		<Show
			when={job()}
			fallback={
				<p class="job-detail-note">
					{jobPollView().phase === "ready" ? "This job is no longer listed." : "loading details…"}
				</p>
			}
		>
			{(current) => (
				<>
					<Show when={props.standalone}>
						<JobErrors />
					</Show>
					<JobDetail
						job={current()}
						detail={jobDetailOf(props.id)}
						now={now()}
						cancelling={cancellingJobId() === props.id}
						onCancel={props.standalone ? (id) => void cancelOwnJob(id) : undefined}
					/>
				</>
			)}
		</Show>
	);
};
