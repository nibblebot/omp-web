import type {
	WireAsyncFrame,
	WireAsyncState,
	WireEvalLive,
	WireEvalStatusEvent,
	WireToolLive,
	WireWaitJob,
	WireWaitLive,
} from "./protocol";
import { isRecord } from "./type-guards";

/** Status events a live eval frame carries: the card's folded window (the SDK TUI keeps the newest 8). */
export const EVAL_LIVE_EVENTS = 8;
/** Characters a status field or job text keeps (the SDK TUI's one-line status width). */
export const LIVE_TEXT_CHARS = 200;
/** Scalar fields a status event keeps. */
const EVENT_FIELDS = 16;
/** Jobs a live wait frame lists. */
const WAIT_LIVE_JOBS = 64;

/** Status event fields that never reach a card line: a helper's returned text and the thinking level of an agent row. */
const OMITTED_EVENT_FIELDS: Record<string, true> = {
	op: true,
	preview: true,
	resolvedThinkingLevel: true,
};

const JOB_TYPES: Record<string, WireWaitJob["type"]> = { bash: "bash", task: "task", eval: "eval" };
const JOB_STATUSES: Record<string, WireWaitJob["status"]> = {
	running: "running",
	completed: "completed",
	failed: "failed",
	cancelled: "cancelled",
};

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function slimEvent(raw: unknown): WireEvalStatusEvent | undefined {
	if (!isRecord(raw) || typeof raw.op !== "string" || raw.op === "") return undefined;
	const event: WireEvalStatusEvent = { op: clip(raw.op, LIVE_TEXT_CHARS) };
	let fields = 0;
	for (const key of Object.keys(raw)) {
		if (OMITTED_EVENT_FIELDS[key] === true) continue;
		if (fields >= EVENT_FIELDS) break;
		const value = raw[key];
		if (typeof value === "string") event[key] = clip(value, LIVE_TEXT_CHARS);
		else if (typeof value === "boolean" || finite(value) !== undefined)
			event[key] = value as boolean | number;
		else continue;
		fields++;
	}
	return event;
}

/**
 * The newest `limit` status events of an eval call's details (`statusEvents`,
 * `statusEventsElided`) as scalar-only events, plus how many older ones the
 * card leaves behind. Undefined when the call has logged nothing. The live
 * frame uses {@link EVAL_LIVE_EVENTS}; a settled card reads its whole bounded log.
 */
export function slimEvalStatus(
	details: unknown,
	limit = EVAL_LIVE_EVENTS,
): WireEvalLive | undefined {
	if (!isRecord(details)) return undefined;
	const events = Array.isArray(details.statusEvents) ? details.statusEvents : [];
	const dropped = finite(details.statusEventsElided) ?? 0;
	const status: WireEvalStatusEvent[] = [];
	let skipped = 0;
	for (let i = Math.max(0, events.length - limit); i < events.length; i++) {
		const event = slimEvent(events[i]);
		if (event) status.push(event);
		else skipped++;
	}
	const elided = dropped + Math.max(0, events.length - limit) + skipped;
	if (status.length === 0 && elided === 0) return undefined;
	return { kind: "eval", status, ...(elided > 0 ? { elided } : {}) };
}

function slimJob(raw: unknown): WireWaitJob | undefined {
	if (!isRecord(raw)) return undefined;
	const type = typeof raw.type === "string" ? JOB_TYPES[raw.type] : undefined;
	const status = typeof raw.status === "string" ? JOB_STATUSES[raw.status] : undefined;
	if (typeof raw.id !== "string" || type === undefined || status === undefined) return undefined;
	const exitCode = finite(raw.exitCode);
	const completionPercent = finite(raw.completionPercent);
	const stage = typeof raw.stage === "string" ? raw.stage.trim() : "";
	const intent = typeof raw.intent === "string" ? raw.intent.trim() : "";
	return {
		id: clip(raw.id, LIVE_TEXT_CHARS),
		type,
		status,
		label: typeof raw.label === "string" ? clip(raw.label, LIVE_TEXT_CHARS) : "",
		durationMs: Math.max(0, finite(raw.durationMs) ?? 0),
		...(intent !== "" ? { intent: clip(intent, LIVE_TEXT_CHARS) } : {}),
		...(exitCode !== undefined ? { exitCode } : {}),
		...(stage !== "" ? { stage: clip(stage, LIVE_TEXT_CHARS) } : {}),
		...(completionPercent !== undefined && status === "running" ? { completionPercent } : {}),
	};
}

/**
 * The watched jobs of a wait call's details (`jobs`, the SDK's `JobSnapshot[]`)
 * without their results, widgets and model info. Undefined when the call lists no job.
 */
export function slimWaitJobs(details: unknown): WireWaitLive | undefined {
	if (!isRecord(details) || !Array.isArray(details.jobs)) return undefined;
	const jobs: WireWaitJob[] = [];
	for (const raw of details.jobs) {
		const job = slimJob(raw);
		if (job) jobs.push(job);
		if (jobs.length >= WAIT_LIVE_JOBS) break;
	}
	return jobs.length > 0 ? { kind: "wait", jobs } : undefined;
}

/** The live status a running tool's partial `details` carries, for the tools that have a live card. */
export function toolLiveOf(toolName: string, details: unknown): WireToolLive | undefined {
	switch (toolName) {
		case "eval":
			return slimEvalStatus(details);
		case "wait":
			return slimWaitJobs(details);
		default:
			return undefined;
	}
}

/**
 * Whether two live frames show the same card. A wait job's `durationMs` is a
 * clock the receiver advances, so a tick alone is not a change.
 */
export function sameToolLive(a: WireToolLive | undefined, b: WireToolLive | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return JSON.stringify(liveKey(a)) === JSON.stringify(liveKey(b));
}

function liveKey(live: WireToolLive): unknown {
	return live.kind === "wait"
		? { kind: live.kind, jobs: live.jobs.map(({ durationMs: _clock, ...job }) => job) }
		: live;
}

const ASYNC_STATES: Record<string, WireAsyncState> = {
	running: "running",
	completed: "completed",
	failed: "failed",
	cancelled: "cancelled",
};

/**
 * The job frame of a backgrounded call's partial `details` (`async.state`, and the
 * `exitCode` a failed command reports). Undefined for a call that is not a background job's card.
 */
export function slimAsyncFrame(details: unknown): WireAsyncFrame | undefined {
	if (!isRecord(details) || !isRecord(details.async)) return undefined;
	const raw = details.async.state;
	const state = typeof raw === "string" ? ASYNC_STATES[raw] : undefined;
	if (state === undefined) return undefined;
	const exitCode = finite(details.exitCode);
	return { state, ...(exitCode !== undefined ? { exitCode } : {}) };
}

/** Whether two job frames say the same thing. */
export function sameAsyncFrame(
	a: WireAsyncFrame | undefined,
	b: WireAsyncFrame | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.state === b.state && a.exitCode === b.exitCode;
}

/**
 * What a bash or eval call's `details.replies` hold: the text the call wrote to `out://`
 * (a reply the user sees as prose after the card), oldest first. Each partial and the
 * settled result repeat the replies so far. Undefined when there are none.
 */
export function toolReplies(details: unknown): string[] | undefined {
	if (!isRecord(details) || !Array.isArray(details.replies)) return undefined;
	const replies = details.replies.filter(
		(reply): reply is string => typeof reply === "string" && reply.trim() !== "",
	);
	return replies.length > 0 ? replies : undefined;
}

/** Whether two reply lists say the same thing. */
export function sameReplies(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined,
): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.length === b.length && a.every((reply, i) => reply === b[i]);
}
