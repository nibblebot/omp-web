import { For, Show, type Component } from "solid-js";
import type { JobDto, JobTreePlaceDto, JobTreeRowDto } from "#lib/wire/protocol";
import { JOB_STATUS_LABEL, jobElapsedMs } from "../../store/jobs";
import { formatDuration } from "../../subagents/format";
import { ConfirmButton } from "../ui/ConfirmButton";
import { BotIcon } from "../ui/icons";
import { JobTypeIcon } from "./JobTypeIcon";
import { JobWidgetGlance } from "./JobWidget";

/** Rails of the enclosing levels, then the branch into this row; nothing at the top level. */
const TreeGuide: Component<{ place: JobTreePlaceDto }> = (props) => (
	<Show when={props.place.depth > 0}>
		<span class="job-guide" aria-hidden="true">
			<For each={props.place.rails}>
				{(continues) => <span class="job-rail" data-continues={continues ? "" : undefined} />}
			</For>
			<span class="job-branch" data-last={props.place.last ? "" : undefined} />
		</span>
	</Show>
);

/** A job's meta line: what kind it is, the subagent it runs, and the agent that owns it when that is not this session. */
function metaOf(job: JobDto, runsAgent: string | undefined): string[] {
	const parts: string[] = [job.type];
	// A spawned subagent's task job takes the agent's id as its own: name it once.
	if (runsAgent !== undefined && runsAgent !== job.id) parts.push(`runs ${runsAgent}`);
	if (!job.own && job.ownerId !== undefined) parts.push(`by ${job.ownerId}`);
	return parts;
}

/**
 * One row of the jobs tree: the rails of its place in the tree, its status,
 * what it runs, its owner, how long it has run, Cancel on this session's
 * own running jobs, and under them a running job's widget glance (a mini chart
 * and its headline figure). A subagent's job is watch-only, and a header row
 * names a subagent whose task job is no longer listed.
 */
export const JobRow: Component<{
	row: JobTreeRowDto;
	/** Epoch ms the running jobs count their run time up to. */
	now: number;
	selected?: boolean;
	/** The row opens a body under it (Activities accordion): it reports `aria-expanded` and names the body it controls. */
	expanded?: boolean;
	controlsId?: string;
	/** Cancel for this job is in flight. */
	cancelling?: boolean;
	onSelect?: (jobId: string) => void;
	onCancel?: (jobId: string) => void;
}> = (props) => {
	const job = (): JobDto | undefined => {
		const row = props.row;
		return row.kind === "job" ? row.job : undefined;
	};
	return (
		<Show
			when={job()}
			fallback={
				<div class="job-row job-row-agent">
					<TreeGuide place={props.row} />
					<span class="job-agent-head">
						<BotIcon class="job-type-icon" />
						<span class="job-agent-name">
							{props.row.kind === "agent" ? props.row.agent.id : ""}
						</span>
						<span class="job-agent-note">subagent</span>
					</span>
				</div>
			}
		>
			{(current) => {
				const elapsed = () => jobElapsedMs(current(), props.now);
				const runsAgent = () => {
					const row = props.row;
					return row.kind === "job" ? row.agent?.id : undefined;
				};
				const widget = () => {
					const row = props.row;
					return row.kind === "job" ? row.widget : undefined;
				};
				return (
					<div
						class="job-row"
						data-status={current().status}
						data-selected={props.selected ? "" : undefined}
					>
						<TreeGuide place={props.row} />
						<button
							type="button"
							class="job-row-main"
							aria-current={props.expanded === undefined && props.selected ? "true" : undefined}
							aria-expanded={props.expanded}
							aria-controls={props.expanded ? props.controlsId : undefined}
							onClick={() => props.onSelect?.(current().id)}
						>
							<span class="job-status" data-status={current().status}>
								{JOB_STATUS_LABEL[current().status]}
							</span>
							<span class="job-label" title={current().label}>
								<JobTypeIcon type={current().type} class="job-type-icon" />
								{current().label}
							</span>
							<Show when={elapsed() !== undefined}>
								<span class="job-duration">{formatDuration(elapsed() ?? 0)}</span>
							</Show>
							<span class="job-meta">{metaOf(current(), runsAgent()).join(" · ")}</span>
							<Show when={widget()}>
								{(view) => (
									<span class="job-row-glance">
										<JobWidgetGlance view={view()} />
									</span>
								)}
							</Show>
						</button>
						<Show when={current().own && current().status === "running"}>
							<ConfirmButton
								class="job-cancel"
								label="Cancel"
								confirmLabel="Confirm"
								title={`Cancel ${current().label}`}
								disabled={props.cancelling === true}
								onConfirm={() => props.onCancel?.(current().id)}
							/>
						</Show>
					</div>
				);
			}}
		</Show>
	);
};
