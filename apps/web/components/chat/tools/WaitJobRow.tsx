import { createResource, Show, type Component } from "solid-js";
import type { WireJobWidgetView, WireWaitJob } from "#lib/wire/protocol";
import { jobWidgetGlance } from "../../../chat/job-widget";
import { jobTitle } from "../../../chat/wait-details";
import { jobElapsedMs, type RunJob } from "../../../chat/wait-runs";
import { jobWidgetView } from "../../../store/job-widgets";
import { openActivities } from "../../../store/activities";
import { fetchJobDetail } from "../../../store/jobs";
import { formatDuration } from "../../../subagents/format";
import { JobTypeIcon } from "../../jobs/JobTypeIcon";
import { JobWidget, JobWidgetGlance } from "../../jobs/JobWidget";
import { ArrowUpIcon, ChevronRightIcon } from "../../ui/icons";

/** Lines of a job's output the expanded row keeps (the tail). */
const OUTPUT_TAIL_LINES = 12;

const STATUS_GLYPH: Record<WireWaitJob["status"], string> = {
	running: "\u25cf",
	completed: "\u2713",
	failed: "\u2715",
	cancelled: "\u25a0",
};

/** Ring fill bands (0 to 4): the ring shifts from the accent toward the success color as the estimate grows. */
const ringBand = (percent: number): number => Math.min(4, Math.floor(percent / 25));

const RING_RADIUS = 8;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** A subagent's own completion estimate, as a ring. */
const CompletionRing: Component<{ percent: number }> = (props) => {
	const percent = () => Math.max(0, Math.min(100, Math.round(props.percent)));
	return (
		<svg
			class="wait-job-ring"
			viewBox="0 0 20 20"
			role="img"
			aria-label={`Completion estimate ${percent()}%`}
			data-band={ringBand(percent())}
		>
			<title>{`The agent's own completion estimate: ${percent()}%`}</title>
			<circle class="wait-job-ring-track" cx="10" cy="10" r={RING_RADIUS} />
			<circle
				class="wait-job-ring-fill"
				cx="10"
				cy="10"
				r={RING_RADIUS}
				stroke-dasharray={`${(RING_CIRCUMFERENCE * percent()) / 100} ${RING_CIRCUMFERENCE}`}
			/>
		</svg>
	);
};

/** The job's kind as a small icon, with its name for screen readers and a tooltip. */
const WaitJobType: Component<{ type: WireWaitJob["type"] }> = (props) => (
	<span class="wait-job-type" title={props.type}>
		<JobTypeIcon type={props.type} />
		<span class="visually-hidden">{props.type}</span>
	</span>
);

/** The widget a row shows: a running job's current one from the store, else the one the wait kept. */
function rowWidget(entry: RunJob): WireJobWidgetView | undefined {
	return entry.job.status === "running"
		? (jobWidgetView(entry.job.id) ?? entry.widget)
		: entry.widget;
}

/**
 * What an expanded row shows beyond its line: the job's whole widget, its
 * output tail and the actions. The output is fetched once when the row opens
 * (`fetchJobDetail`); a job the session no longer lists says so.
 */
const WaitJobDetail: Component<{ entry: RunJob; onJump?: () => void }> = (props) => {
	const [detail] = createResource(() => props.entry.job.id, fetchJobDetail);
	const widget = () => rowWidget(props.entry) ?? detail()?.widget;
	// A task job is a subagent (it carries the agent's id): the Jobs section lists the rest.
	const section = () => (props.entry.job.type === "task" ? "subagents" : "jobs");
	const output = () => {
		const text = detail()?.output?.trimEnd();
		if (!text) return undefined;
		const lines = text.split("\n");
		return {
			text: lines.slice(-OUTPUT_TAIL_LINES).join("\n"),
			cut: lines.length > OUTPUT_TAIL_LINES,
		};
	};
	return (
		<div class="wait-job-detail">
			<Show when={widget()}>{(view) => <JobWidget view={view()} />}</Show>
			<Show when={output()}>
				{(tail) => (
					<>
						<pre class="terminal wait-job-output">{tail().text}</pre>
						<Show when={tail().cut || detail()?.outputTruncated}>
							<div class="wait-job-note">Only the end of the output is shown.</div>
						</Show>
					</>
				)}
			</Show>
			<Show when={detail.loading}>
				<div class="wait-job-note">loading output…</div>
			</Show>
			<Show when={!detail.loading && detail() === null}>
				<div class="wait-job-note">This job is no longer listed by the session.</div>
			</Show>
			<div class="wait-job-actions">
				<button
					type="button"
					class="wait-job-action"
					onClick={() =>
						openActivities({
							section: section(),
							item: { section: section(), id: props.entry.job.id },
						})
					}
				>
					Open in Activities
				</button>
				<Show when={props.onJump}>
					{(jump) => (
						<button type="button" class="wait-job-action" onClick={() => jump()()}>
							Jump to the card that started it
						</button>
					)}
				</Show>
			</div>
		</div>
	);
};

/**
 * One watched job as one line: status glyph (pulsing while its call is live),
 * what kind it is, its title, its id when that differs, what it is doing (a
 * widget's glance, else a subagent's stage), a subagent's completion ring, a
 * failure's exit code and the clock. The line is a button: it opens the job's
 * widget, output tail and actions under it. `onJump`, when the transcript still
 * holds the card that started the job, adds an icon button that scrolls to it.
 */
export const WaitJobRow: Component<{
	entry: RunJob;
	/** Epoch ms a running live job counts its run time up to. */
	now: number;
	expanded: boolean;
	onToggle: () => void;
	onJump?: () => void;
}> = (props) => {
	const job = () => props.entry.job;
	const title = () => jobTitle(job());
	const glance = (): WireJobWidgetView | undefined => {
		const view = rowWidget(props.entry);
		// A settled row glances only a spec-driven widget that has a figure; a basic, still-authoring or figureless one holds nothing worth a line.
		if (job().status === "running") return view;
		return view?.state === "live" && jobWidgetGlance(view) !== undefined ? view : undefined;
	};
	const note = () => {
		const label = job().type === "task" ? (job().label.split(/\r?\n/, 1)[0]?.trim() ?? "") : "";
		return job().stage ?? label;
	};
	const failure = () =>
		job().exitCode !== undefined && job().exitCode !== 0 ? `exit ${job().exitCode}` : undefined;
	return (
		<li class="wait-job" data-status={job().status} data-expanded={props.expanded ? "" : undefined}>
			<div class="wait-job-line">
				<button
					type="button"
					class="wait-job-toggle"
					aria-expanded={props.expanded}
					onClick={() => props.onToggle()}
				>
					<span
						class="wait-job-dot"
						data-pulse={props.entry.at !== undefined && job().status === "running" ? "" : undefined}
						aria-hidden="true"
					>
						{STATUS_GLYPH[job().status]}
					</span>
					<WaitJobType type={job().type} />
					<span class="wait-job-title" title={title()}>
						{title()}
					</span>
					<Show when={job().id !== title()}>
						<span class="wait-job-id">{job().id}</span>
					</Show>
					<Show when={glance()} fallback={<span class="wait-job-note-inline">{note()}</span>}>
						{(view) => (
							<span class="wait-job-glance">
								<JobWidgetGlance view={view()} />
							</span>
						)}
					</Show>
					<Show when={job().completionPercent !== undefined}>
						<CompletionRing percent={job().completionPercent ?? 0} />
					</Show>
					<Show when={failure()}>
						<span class="wait-job-failure">{failure()}</span>
					</Show>
					<span class="wait-job-clock">{formatDuration(jobElapsedMs(props.entry, props.now))}</span>
					<ChevronRightIcon class="wait-job-chevron" />
					<span class="visually-hidden">{job().status}</span>
				</button>
				<Show when={props.onJump}>
					{(jump) => (
						<button
							type="button"
							class="wait-job-jump"
							title="Jump to the card that started this job"
							aria-label={`Jump to the card that started ${title()}`}
							onClick={() => jump()()}
						>
							<ArrowUpIcon />
						</button>
					)}
				</Show>
			</div>
			<Show when={props.expanded}>
				<WaitJobDetail entry={props.entry} onJump={props.onJump} />
			</Show>
		</li>
	);
};
