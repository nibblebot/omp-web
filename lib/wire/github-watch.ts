import type {
	WireGithubFailedLog,
	WireGithubJob,
	WireGithubRun,
	WireGithubStep,
	WireGithubWatch,
} from "./protocol";
import { isRecord } from "./type-guards";

/** Characters a name, status or note keeps. */
export const WATCH_TEXT_CHARS = 200;
/** Characters of a failed job's log tail the wire carries (the SDK already cut it to the call's `tail` lines). */
export const WATCH_TAIL_CHARS = 8000;
/** Runs a commit watch lists. */
const WATCH_RUNS = 32;
/** Jobs a run lists. */
const WATCH_JOBS = 256;
/** Steps a job lists. */
const WATCH_STEPS = 256;
/** Failed-job log tails a settled watch lists. */
const WATCH_FAILED_LOGS = 32;

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

function text(value: unknown, max = WATCH_TEXT_CHARS): string | undefined {
	return typeof value === "string" && value !== "" ? clip(value, max) : undefined;
}

function whole(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function seconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: undefined;
}

function slimStep(raw: unknown): WireGithubStep | undefined {
	if (!isRecord(raw)) return undefined;
	const number = whole(raw.number);
	if (number === undefined) return undefined;
	const status = text(raw.status);
	const conclusion = text(raw.conclusion);
	const durationSeconds = seconds(raw.durationSeconds);
	return {
		number,
		name: text(raw.name) ?? `step-${number}`,
		...(status !== undefined ? { status } : {}),
		...(conclusion !== undefined ? { conclusion } : {}),
		...(durationSeconds !== undefined ? { durationSeconds } : {}),
	};
}

function slimJob(raw: unknown): WireGithubJob | undefined {
	if (!isRecord(raw)) return undefined;
	const id = whole(raw.id);
	if (id === undefined) return undefined;
	const status = text(raw.status);
	const conclusion = text(raw.conclusion);
	const durationSeconds = seconds(raw.durationSeconds);
	const url = text(raw.url, 500);
	const steps = Array.isArray(raw.steps)
		? raw.steps
				.slice(0, WATCH_STEPS)
				.map(slimStep)
				.filter((step): step is WireGithubStep => step !== undefined)
		: undefined;
	return {
		id,
		name: text(raw.name) ?? `job-${id}`,
		...(status !== undefined ? { status } : {}),
		...(conclusion !== undefined ? { conclusion } : {}),
		...(durationSeconds !== undefined ? { durationSeconds } : {}),
		...(url !== undefined ? { url } : {}),
		...(steps !== undefined ? { steps } : {}),
	};
}

function slimRun(raw: unknown): WireGithubRun | undefined {
	if (!isRecord(raw)) return undefined;
	const id = whole(raw.id);
	if (id === undefined) return undefined;
	const workflowName = text(raw.workflowName);
	const displayTitle = text(raw.displayTitle);
	const status = text(raw.status);
	const conclusion = text(raw.conclusion);
	const branch = text(raw.branch);
	const headSha = text(raw.headSha);
	const url = text(raw.url, 500);
	const jobs = Array.isArray(raw.jobs)
		? raw.jobs
				.slice(0, WATCH_JOBS)
				.map(slimJob)
				.filter((job): job is WireGithubJob => job !== undefined)
		: [];
	return {
		id,
		...(workflowName !== undefined ? { workflowName } : {}),
		...(displayTitle !== undefined ? { displayTitle } : {}),
		...(status !== undefined ? { status } : {}),
		...(conclusion !== undefined ? { conclusion } : {}),
		...(branch !== undefined ? { branch } : {}),
		...(headSha !== undefined ? { headSha } : {}),
		...(url !== undefined ? { url } : {}),
		jobs,
	};
}

function slimFailedLog(raw: unknown): WireGithubFailedLog | undefined {
	if (!isRecord(raw)) return undefined;
	const runId = whole(raw.runId);
	const jobName = text(raw.jobName);
	if (runId === undefined || jobName === undefined) return undefined;
	const workflowName = text(raw.workflowName);
	const conclusion = text(raw.conclusion);
	const tail = text(raw.tail, WATCH_TAIL_CHARS);
	const unavailableReason = text(raw.unavailableReason, 500);
	return {
		runId,
		jobName,
		available: raw.available === true,
		...(workflowName !== undefined ? { workflowName } : {}),
		...(conclusion !== undefined ? { conclusion } : {}),
		...(tail !== undefined ? { tail } : {}),
		...(unavailableReason !== undefined ? { unavailableReason } : {}),
	};
}

/**
 * The Actions run watch of a `github` call's `details.watch` (the SDK's `GhRunWatchViewDetails`),
 * bounded, without its poll counter (which changes on every poll and shows nowhere). Undefined for
 * any other tool, for any other `github` op and for a shape that is not a watch. A job whose GitHub
 * response listed no steps keeps `steps` absent; a step without a duration keeps none (the SDK omits
 * it for a step that has not started).
 */
export function slimGithubWatch(toolName: string, details: unknown): WireGithubWatch | undefined {
	if (toolName !== "github" || !isRecord(details) || !isRecord(details.watch)) return undefined;
	const raw = details.watch;
	if ((raw.mode !== "run" && raw.mode !== "commit") || typeof raw.repo !== "string")
		return undefined;
	if (raw.state !== "watching" && raw.state !== "completed") return undefined;
	const branch = text(raw.branch);
	const headSha = text(raw.headSha);
	const note = text(raw.note, 400);
	const run = slimRun(raw.run);
	const runs = Array.isArray(raw.runs)
		? raw.runs
				.slice(0, WATCH_RUNS)
				.map(slimRun)
				.filter((entry): entry is WireGithubRun => entry !== undefined)
		: undefined;
	const failedLogs = Array.isArray(raw.failedLogs)
		? raw.failedLogs
				.slice(0, WATCH_FAILED_LOGS)
				.map(slimFailedLog)
				.filter((entry): entry is WireGithubFailedLog => entry !== undefined)
		: [];
	return {
		mode: raw.mode,
		state: raw.state,
		repo: clip(raw.repo, WATCH_TEXT_CHARS),
		...(branch !== undefined ? { branch } : {}),
		...(headSha !== undefined ? { headSha } : {}),
		...(note !== undefined ? { note } : {}),
		...(run !== undefined ? { run } : {}),
		...(runs !== undefined ? { runs } : {}),
		...(failedLogs.length > 0 ? { failedLogs } : {}),
	};
}

/** Whether two watch snapshots show the same card. */
export function sameGithubWatch(
	a: WireGithubWatch | undefined,
	b: WireGithubWatch | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return JSON.stringify(a) === JSON.stringify(b);
}
