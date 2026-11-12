import { slimGithubWatch } from "#lib/wire/github-watch";
import type {
	WireGithubJob,
	WireGithubRun,
	WireGithubStep,
	WireGithubWatch,
} from "#lib/wire/protocol";
import type { ToolItem } from "../state";
import { formatDuration } from "../subagents/format";

/**
 * How a run, job or step reads: GitHub's `status` and `conclusion` strings folded into the states a
 * card draws (the SDK TUI's grouping: neutral counts as success, timed out, action required and
 * startup failure as failure). `unknown` is a state this code does not recognise: it draws muted
 * and claims neither queued nor settled.
 */
export type WatchState =
	| "queued"
	| "running"
	| "success"
	| "failure"
	| "skipped"
	| "cancelled"
	| "unknown";

const QUEUED_STATUSES: Record<string, true> = {
	queued: true,
	requested: true,
	waiting: true,
	pending: true,
};
const FAILURE_CONCLUSIONS: Record<string, true> = {
	failure: true,
	timed_out: true,
	action_required: true,
	startup_failure: true,
};

/** The state of a run, job or step from its GitHub `status` and `conclusion` (the conclusion wins once there is one). */
export function watchState(entry: { status?: string; conclusion?: string }): WatchState {
	const { status, conclusion } = entry;
	if (conclusion !== undefined) {
		if (conclusion === "success" || conclusion === "neutral") return "success";
		if (conclusion === "skipped") return "skipped";
		if (conclusion === "cancelled") return "cancelled";
		return Object.hasOwn(FAILURE_CONCLUSIONS, conclusion) ? "failure" : "unknown";
	}
	if (status === "in_progress") return "running";
	return status !== undefined && Object.hasOwn(QUEUED_STATUSES, status) ? "queued" : "unknown";
}

/** The watch a `github` card draws: the settled call's `details.watch`, else the last one a running call reported. Undefined for any other op. */
export function githubWatchOf(item: ToolItem): WireGithubWatch | undefined {
	return slimGithubWatch("github", item.details) ?? item.watch;
}

/** Whether a `github` call is a run watch, from its args: true before its first snapshot arrives. */
export function isRunWatchCall(args: unknown): boolean {
	return typeof args === "object" && args !== null && "op" in args && args.op === "run_watch";
}

/** `12s`, `1m05s`; an unknown duration (a step that never started) is undefined. */
export function formatWatchDuration(seconds: number | undefined): string | undefined {
	if (seconds === undefined) return undefined;
	return seconds < 1 ? "0s" : formatDuration(seconds * 1000);
}

/** What one job's steps are doing, for its summary line. */
export interface JobProgress {
	total: number;
	/** Steps with a conclusion, or reported completed. */
	done: number;
	/** The first step that ended in failure. */
	failed: WireGithubStep | undefined;
	/** The step running now. */
	running: WireGithubStep | undefined;
}

/** Progress of a job's steps; undefined when GitHub reported none for it. */
export function jobProgress(job: WireGithubJob): JobProgress | undefined {
	const steps = job.steps;
	if (steps === undefined || steps.length === 0) return undefined;
	return {
		total: steps.length,
		done: steps.filter((step) => step.conclusion !== undefined || step.status === "completed")
			.length,
		failed: steps.find((step) => watchState(step) === "failure"),
		running: steps.find((step) => watchState(step) === "running"),
	};
}

/** The runs of a watch: the one run of a run watch, every run of a commit watch. */
export function watchRuns(watch: WireGithubWatch): readonly WireGithubRun[] {
	if (watch.mode === "run") return watch.run === undefined ? [] : [watch.run];
	return watch.runs ?? [];
}

/**
 * One state for the whole watch: a failed run fails it, else a run still going keeps it running,
 * else queued runs leave it queued, else every run's own state decides (all success reads success).
 * A watch with no run yet is queued.
 */
export function watchSummaryState(watch: WireGithubWatch): WatchState {
	const states = watchRuns(watch).map(watchState);
	if (states.length === 0) return "queued";
	for (const wanted of ["failure", "running", "queued", "cancelled"] as const)
		if (states.includes(wanted)) return wanted;
	return states.every((state) => state === "success") ? "success" : (states[0] ?? "unknown");
}

/** The run's name for its line: its workflow, else its title, else `run #id`. */
export function runLabel(run: WireGithubRun): string {
	return run.workflowName ?? run.displayTitle ?? `run #${run.id}`;
}

/** First seven characters of a commit id. */
export function shortSha(sha: string | undefined): string | undefined {
	return sha === undefined ? undefined : sha.slice(0, 7);
}

/** A URL from the watch details that is safe to link: GitHub's own `http(s)` addresses only. */
export function safeHttpUrl(url: string | undefined): string | undefined {
	return url !== undefined && /^https?:\/\//i.test(url) ? url : undefined;
}

/** The word a state shows as, in the summary chip and for screen readers. */
export const WATCH_STATE_LABELS: Record<WatchState, string> = {
	queued: "queued",
	running: "running",
	success: "passed",
	failure: "failed",
	skipped: "skipped",
	cancelled: "cancelled",
	unknown: "unknown",
};
