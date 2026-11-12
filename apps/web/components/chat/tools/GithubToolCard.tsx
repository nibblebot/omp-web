import { createEffect, createMemo, createSignal, Index, on, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type {
	WireGithubFailedLog,
	WireGithubJob,
	WireGithubRun,
	WireGithubStep,
	WireGithubWatch,
} from "#lib/wire/protocol";
import {
	formatWatchDuration,
	githubWatchOf,
	isRunWatchCall,
	jobProgress,
	runLabel,
	safeHttpUrl,
	shortSha,
	watchRuns,
	watchState,
	watchSummaryState,
	WATCH_STATE_LABELS,
	type WatchState,
} from "../../../chat/github-watch";
import { state, type ToolItem } from "../../../state";
import {
	BanIcon,
	CheckIcon,
	ChevronRightIcon,
	CircleDotIcon,
	CircleIcon,
	LoaderIcon,
	MinusIcon,
	XIcon,
	type IconProps,
} from "../../ui/icons";
import { createLazyOpen } from "../../ui/lazy-open";
import { GenericToolCard } from "./GenericToolCard";
import { ToolCardShell } from "./ToolCardShell";

const STATE_ICONS: Record<WatchState, Component<IconProps>> = {
	queued: CircleIcon,
	running: LoaderIcon,
	success: CheckIcon,
	failure: XIcon,
	skipped: MinusIcon,
	cancelled: BanIcon,
	unknown: CircleDotIcon,
};

/** The state of a run, job or step: an icon tinted by it (a running one spins) and its word for screen readers. */
const StateIcon: Component<{ state: WatchState }> = (props) => (
	<span class="gh-state" data-state={props.state} title={WATCH_STATE_LABELS[props.state]}>
		<Dynamic
			component={STATE_ICONS[props.state]}
			class={props.state === "running" ? "tool-spin" : undefined}
		/>
		<span class="visually-hidden">{WATCH_STATE_LABELS[props.state]}</span>
	</span>
);

const StepRow: Component<{ step: WireGithubStep }> = (props) => {
	const stepState = () => watchState(props.step);
	const duration = () => formatWatchDuration(props.step.durationSeconds);
	return (
		<li class="gh-step" data-state={stepState()}>
			<StateIcon state={stepState()} />
			<span class="gh-step-number">#{props.step.number}</span>
			<span class="gh-step-name">{props.step.name}</span>
			<Show when={duration()}>{(text) => <span class="gh-duration">{text()}</span>}</Show>
		</li>
	);
};

/** One job's line: state, name, what its steps are doing, how long it ran. */
const JobLine: Component<{ job: WireGithubJob }> = (props) => {
	const progress = () => jobProgress(props.job);
	const note = () => {
		const steps = progress();
		if (steps === undefined) return undefined;
		if (steps.failed !== undefined) return `failed at #${steps.failed.number} ${steps.failed.name}`;
		if (steps.running !== undefined)
			return `step ${steps.running.number}/${steps.total} ${steps.running.name}`;
		return `${steps.done}/${steps.total} steps`;
	};
	const duration = () => formatWatchDuration(props.job.durationSeconds);
	return (
		<>
			<StateIcon state={watchState(props.job)} />
			<span class="gh-job-name">{props.job.name}</span>
			<Show when={note()}>{(text) => <span class="gh-job-note">{text()}</span>}</Show>
			<Show when={duration()}>{(text) => <span class="gh-duration">{text()}</span>}</Show>
		</>
	);
};

/**
 * A job: with steps, a `<details>` that is open while the job runs or failed (the steps you want
 * to watch), closed once it passed. The user's own toggle wins until Ctrl+O resets it, as on a card.
 * Its step list mounts on the first open.
 */
const JobRow: Component<{ job: WireGithubJob }> = (props) => {
	const jobState = () => watchState(props.job);
	const defaultOpen = () =>
		state.toolsExpanded || jobState() === "running" || jobState() === "failure";
	const [userOpen, setUserOpen] = createSignal<boolean | null>(null);
	createEffect(
		on(
			() => state.toolsExpanded,
			() => setUserOpen(null),
			{ defer: true },
		),
	);
	const lazy = createLazyOpen(defaultOpen());
	return (
		<li class="gh-job" data-state={jobState()}>
			<Show
				when={(props.job.steps?.length ?? 0) > 0}
				fallback={
					<div class="gh-job-line">
						<JobLine job={props.job} />
					</div>
				}
			>
				<details
					class="gh-job-details"
					open={userOpen() ?? defaultOpen()}
					onClick={lazy.onClick}
					onToggle={(e) => {
						lazy.onToggle(e);
						if (e.isTrusted && e.currentTarget.open !== defaultOpen())
							setUserOpen(e.currentTarget.open);
					}}
				>
					<summary class="gh-job-line">
						<ChevronRightIcon class="gh-chevron" />
						<JobLine job={props.job} />
					</summary>
					<Show when={lazy.opened() || (userOpen() ?? defaultOpen())}>
						<ol class="gh-steps">
							<Index each={props.job.steps}>{(step) => <StepRow step={step()} />}</Index>
						</ol>
					</Show>
				</details>
			</Show>
		</li>
	);
};

const RunBlock: Component<{ run: WireGithubRun }> = (props) => {
	const url = () => safeHttpUrl(props.run.url);
	const meta = () =>
		[props.run.branch ?? shortSha(props.run.headSha), `#${props.run.id}`].filter(Boolean).join(" ");
	return (
		<section class="gh-run" aria-label={runLabel(props.run)}>
			<div class="gh-run-line">
				<StateIcon state={watchState(props.run)} />
				<Show when={url()} fallback={<span class="gh-run-name">{runLabel(props.run)}</span>}>
					{(href) => (
						<a class="gh-run-name" href={href()} target="_blank" rel="noreferrer">
							{runLabel(props.run)}
						</a>
					)}
				</Show>
				<span class="gh-run-meta">{meta()}</span>
			</div>
			<Show
				when={props.run.jobs.length > 0}
				fallback={<div class="gh-waiting">Waiting for workflow jobs</div>}
			>
				<ul class="gh-jobs">
					<Index each={props.run.jobs}>{(job) => <JobRow job={job()} />}</Index>
				</ul>
			</Show>
		</section>
	);
};

/** A failed job's captured log tail: closed, and its text mounts on the first open. */
const FailedLogRow: Component<{ log: WireGithubFailedLog }> = (props) => {
	const lazy = createLazyOpen(false);
	return (
		<details class="gh-log" onClick={lazy.onClick} onToggle={lazy.onToggle}>
			<summary class="gh-log-summary">
				<ChevronRightIcon class="gh-chevron" />
				<span class="gh-job-name">{props.log.jobName}</span>
				<span class="gh-job-note">{props.log.workflowName ?? `run #${props.log.runId}`}</span>
			</summary>
			<Show when={lazy.opened()}>
				<Show
					when={props.log.available && props.log.tail}
					fallback={
						<div class="gh-waiting">
							Log tail unavailable
							{props.log.unavailableReason ? `: ${props.log.unavailableReason}` : ""}
						</div>
					}
				>
					{(tail) => <pre class="terminal gh-log-tail">{tail()}</pre>}
				</Show>
			</Show>
		</details>
	);
};

/** The header's argument: the op and what it watches (the run's workflow, or the commit's runs). */
const GithubWatchArg: Component<{ watch: WireGithubWatch | undefined }> = (props) => {
	const label = () => {
		const current = props.watch;
		if (current === undefined) return "";
		if (current.mode === "run" && current.run !== undefined) return runLabel(current.run);
		const runs = watchRuns(current).length;
		return `${shortSha(current.headSha) ?? current.repo} · ${runs} ${runs === 1 ? "run" : "runs"}`;
	};
	return <>run_watch {label()}</>;
};

/**
 * github: an Actions run watch draws its jobs and their ordered steps, with state and duration,
 * live as the SDK polls (each update carries the whole snapshot) and final when the watch ends.
 * Durations are the SDK's, cut when it polled: the details carry no start time, so a running
 * step's duration is that poll's, not a ticking clock. Every other op (and a settled call that
 * holds no watch) is the generic card.
 */
export const GithubToolCard: Component<{ item: ToolItem }> = (props) => {
	const watch = createMemo(() => githubWatchOf(props.item));
	const waiting = () => props.item.status === "running" && isRunWatchCall(props.item.args);
	return (
		<Show
			when={watch() !== undefined || waiting()}
			fallback={<GenericToolCard item={props.item} />}
		>
			<ToolCardShell
				name="github"
				arg={<GithubWatchArg watch={watch()} />}
				status={props.item.status}
				class="github-tool"
				meta={
					<Show when={watch()}>
						{(current) => {
							const summary = () => watchSummaryState(current());
							return (
								<span class="gh-summary" data-state={summary()}>
									{WATCH_STATE_LABELS[summary()]}
								</span>
							);
						}}
					</Show>
				}
			>
				<div class="gh-body">
					<Show when={watch()}>
						{(current) => (
							<>
								<Show when={current().note}>{(note) => <div class="gh-note">{note()}</div>}</Show>
								<Show
									when={watchRuns(current()).length > 0}
									fallback={<div class="gh-waiting">Waiting for workflow runs</div>}
								>
									<Index each={watchRuns(current())}>{(run) => <RunBlock run={run()} />}</Index>
								</Show>
								<Show when={current().failedLogs}>
									{(logs) => (
										<div class="gh-logs">
											<Index each={logs()}>{(log) => <FailedLogRow log={log()} />}</Index>
										</div>
									)}
								</Show>
							</>
						)}
					</Show>
					<Show when={watch() === undefined}>
						<div class="gh-waiting">Waiting for workflow jobs</div>
					</Show>
				</div>
			</ToolCardShell>
		</Show>
	);
};
