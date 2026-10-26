import { createEffect, createMemo, For, onCleanup, Show, type Component } from "solid-js";
import { createNow } from "../../activities/clock";
import { flatJobRow, visibleJobRows } from "../../activities/jobs";
import { createKeyedRows } from "../../activities/keyed-rows";
import { activityJobRows, jobsSummary } from "../../activities/summary";
import { state } from "../../state";
import { openItemDetail, toggleItemExpanded } from "../../store/activities";
import { acquireJobPollFocus } from "../../store/job-poll";
import { cancelOwnJob, cancellingJobId, clearJobCancelError } from "../../store/jobs";
import { JobRow } from "../jobs/JobRow";
import { ActivityFilterToggle } from "./ActivityFilterToggle";
import { ActivityJobDetail } from "./ActivityJobDetail";
import { ActivitySection } from "./ActivitySection";
import { JobErrors } from "./JobErrors";

const bodyDomId = (id: string): string => `activity-job-body-${id}`;

/**
 * The Jobs section: the session's background jobs without its subagents' task jobs, as one list in poll order,
 * with the All / Running filter in its header. Accordion mode expands a row inline into its detail (any number
 * at once); detail mode opens it in the panel. While the section is on screen (not folded) the shared job poll
 * runs at its fast period.
 */
export const JobsSection: Component = () => {
	const now = createNow();
	const summary = createMemo(jobsSummary);
	const expanded = () => state.activities.expanded.jobs;
	const inline = () => state.activities.mode === "accordion";
	createEffect(() => {
		if (state.activities.collapsedSections.has("jobs")) return;
		onCleanup(acquireJobPollFocus());
	});
	onCleanup(clearJobCancelError);
	const shown = createMemo(() =>
		visibleJobRows(
			activityJobRows(),
			state.activities.filters.jobs,
			inline() ? expanded() : new Set<string>(),
		),
	);
	// Rows render by id, not by object: every poll hands over new row objects, and remounting the list
	// would drop focus and a pending Cancel confirm on each tick.
	const keyed = createKeyedRows(shown, (row) => row.job.id);
	const ids = keyed.ids;
	const onOpen = (id: string) => {
		const ref = { section: "jobs", id } as const;
		if (inline()) toggleItemExpanded(ref);
		else openItemDetail(ref);
	};

	return (
		<ActivitySection
			id="jobs"
			title="Jobs"
			count={{ active: summary().active, total: summary().total }}
			actions={<ActivityFilterToggle section="jobs" label="Show jobs" />}
		>
			<JobErrors />
			<Show when={ids().length > 0} fallback={<p class="activity-empty">No jobs are running.</p>}>
				<ol class="activity-job-list" aria-label="Jobs">
					<For each={ids()}>
						{(id) => {
							const row = keyed.row(id);
							const open = () => inline() && expanded().has(id);
							return (
								<li
									class="activity-job-item"
									data-activity-item={`jobs:${id}`}
									data-open={open() ? "" : undefined}
								>
									<JobRow
										row={flatJobRow(row())}
										now={now()}
										selected={open()}
										expanded={inline() ? open() : undefined}
										controlsId={bodyDomId(id)}
										cancelling={cancellingJobId() === id}
										onSelect={onOpen}
										onCancel={(jobId) => void cancelOwnJob(jobId)}
									/>
									<Show when={open()}>
										<div class="activity-item-body" id={bodyDomId(id)}>
											<ActivityJobDetail id={id} />
										</div>
									</Show>
								</li>
							);
						}}
					</For>
				</ol>
			</Show>
		</ActivitySection>
	);
};
