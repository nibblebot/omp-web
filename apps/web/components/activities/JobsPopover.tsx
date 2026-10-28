import { createMemo, For, onCleanup, onMount, type Component } from "solid-js";
import { createNow } from "../../activities/clock";
import { activeFirst, capRows } from "../../activities/bar";
import { activityJobRows } from "../../activities/summary";
import { openActivities } from "../../store/activities";
import { acquireJobPollFocus } from "../../store/job-poll";
import { JOB_STATUS_LABEL, jobElapsedMs } from "../../store/jobs";
import { formatDuration } from "../../subagents/format";
import { JobTypeIcon } from "../jobs/JobTypeIcon";
import { ActivityPopover } from "./ActivityPopover";
import { createKeyedRows } from "../../activities/keyed-rows";

/**
 * Condensed job list above the bar's Jobs button: type icon, label, elapsed, state. A row
 * opens that job in the panel. While open it marks the shared job poll focused (2 s cadence).
 */
export const JobsPopover: Component<{ anchor: HTMLElement; onClose: () => void }> = (props) => {
	const now = createNow();
	onMount(() => {
		onCleanup(acquireJobPollFocus());
	});
	const rows = createMemo(() =>
		capRows(activeFirst(activityJobRows(), (row) => row.job.status === "running")),
	);
	// Rows render by id, not by object: every job poll hands over new row objects.
	const keyed = createKeyedRows(
		() => rows().shown,
		(row) => row.job.id,
	);
	return (
		<ActivityPopover
			section="jobs"
			title="Jobs"
			anchor={props.anchor}
			onClose={props.onClose}
			more={rows().more}
		>
			<ul class="activity-popover-list">
				<For each={keyed.ids()}>
					{(id) => {
						const row = keyed.row(id);
						const elapsed = () => {
							const ms = jobElapsedMs(row().job, now());
							return ms === undefined ? "" : formatDuration(ms);
						};
						return (
							<li>
								<button
									type="button"
									class="activity-popover-row"
									onClick={() => {
										openActivities({ item: { section: "jobs", id } });
										props.onClose();
									}}
								>
									<span class="activity-popover-glyph" data-status={row().job.status}>
										<JobTypeIcon type={row().job.type} />
									</span>
									<span class="activity-popover-name" title={row().job.label}>
										{row().job.label}
									</span>
									<span class="activity-popover-detail">{elapsed()}</span>
									<span class="activity-popover-state">{JOB_STATUS_LABEL[row().job.status]}</span>
								</button>
							</li>
						);
					}}
				</For>
			</ul>
		</ActivityPopover>
	);
};
