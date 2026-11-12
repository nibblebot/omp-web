/**
 * What one `wait` tool call's `details` give its card: the watched jobs (id,
 * type, status, label, the intent the model gave it, run time, a subagent's stage and completion estimate),
 * each job's widget, running agents with no job row, and whether the call was
 * cut short or consumed a peer message. The SDK's `CoordinationDetails`
 * (pi-tui tools/wait.ts) also carries each job's result text, which is not
 * read. A settled call's widgets are cut by `parseJobWidgetView`; the live
 * frame never carries them. Pure, so the parsing stays testable without a DOM.
 * `chat/wait-runs.ts` folds consecutive calls into one card.
 */
import { parseJobWidgetView } from "#lib/wire/job-widget";
import type { WireJobWidgetView, WireWaitJob } from "#lib/wire/protocol";
import { slimWaitJobs } from "#lib/wire/tool-live";
import { isRecord } from "#lib/wire/type-guards";
import type { ToolItem } from "../state";

/** A running agent that has no job row in the result (a peer-woken or revived subagent). */
export interface WaitAgent {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry. */
	activity?: string;
	/** Time since the agent registered, ms. */
	ageMs: number;
	/** False when no attached session corroborates the running claim. */
	live: boolean;
}

/** One wait call, parsed. */
export interface WaitCall {
	/** The jobs the call lists: a running call's live frame, else the settled details. */
	jobs: WireWaitJob[];
	/** Each settled job's widget view by job id (only jobs whose widget is a view); empty for a running call. */
	widgets: ReadonlyMap<string, WireJobWidgetView>;
	agents: WaitAgent[];
	/** Whether the jobs are a running call's live frame (their clocks advance from `at`). */
	live: boolean;
	/** Epoch ms the live frame arrived; clocks of running jobs advance from it. */
	at?: number;
	/** The wait was cut short by steering, a peer message or a completion notice. */
	interrupted: boolean;
	/** The wait returned a peer message (`details.waited`, only in transcripts before SDK 18.18.9; since then the message is its own agent message card). */
	message: boolean;
}

function parseAgents(details: unknown): WaitAgent[] {
	if (!isRecord(details) || !Array.isArray(details.agents)) return [];
	const agents: WaitAgent[] = [];
	for (const raw of details.agents) {
		if (!isRecord(raw) || typeof raw.id !== "string") continue;
		agents.push({
			id: raw.id,
			...(typeof raw.parentId === "string" ? { parentId: raw.parentId } : {}),
			...(typeof raw.activity === "string" && raw.activity !== ""
				? { activity: raw.activity }
				: {}),
			ageMs: typeof raw.ageMs === "number" && Number.isFinite(raw.ageMs) ? raw.ageMs : 0,
			live: raw.live === true,
		});
	}
	return agents;
}

/** Each job's widget of a settled call's details (`jobs[].widget`), by job id. */
function parseWidgets(details: unknown): Map<string, WireJobWidgetView> {
	const widgets = new Map<string, WireJobWidgetView>();
	if (!isRecord(details) || !Array.isArray(details.jobs)) return widgets;
	for (const raw of details.jobs) {
		if (!isRecord(raw) || typeof raw.id !== "string" || raw.widget === undefined) continue;
		const view = parseJobWidgetView(raw.widget);
		if (view) widgets.set(raw.id, view);
	}
	return widgets;
}

/** Whether `details.waited` holds a peer message: a non-empty list (SDK 18.17.0 returns every queued message, oldest first) or the single message object an older session recorded. Only transcripts before SDK 18.18.9 carry it; since then a wait a message ends reports `interrupted`, and the message arrives as an `irc:incoming` custom message (`store/slices/agent-message.ts`). */
function consumedMessage(waited: unknown): boolean {
	return Array.isArray(waited) ? waited.length > 0 : Boolean(waited);
}

/** One wait call's jobs, widgets and agents, from its live frame while it runs and from its settled details after. */
export function waitCallOf(item: ToolItem): WaitCall {
	const running = item.status === "running";
	const live = running && item.live?.kind === "wait" ? item.live : undefined;
	const jobs = live ? live.jobs : running ? [] : (slimWaitJobs(item.details)?.jobs ?? []);
	const details = isRecord(item.details) ? item.details : undefined;
	return {
		jobs,
		widgets: running ? new Map() : parseWidgets(item.details),
		agents: running ? [] : parseAgents(item.details),
		live: live !== undefined,
		...(live ? { at: live.at } : {}),
		interrupted: details?.interrupted === true,
		message: consumedMessage(details?.waited),
	};
}

/** Counts per status, for the header summary. */
export function waitCounts(jobs: readonly WireWaitJob[]): Record<WireWaitJob["status"], number> {
	const counts = { running: 0, completed: 0, failed: 0, cancelled: 0 };
	for (const job of jobs) counts[job.status]++;
	return counts;
}

/** The first line of a job's text, trimmed. */
function firstLine(text: string | undefined): string {
	return text?.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** A row's raw label: the first line of the command or task description the job runs. */
export function jobLabel(job: WireWaitJob): string {
	return firstLine(job.label);
}

/**
 * A row's title: the purpose the model gave the job (SDK 18.17.0 `intent`), else a
 * subagent's id, else the first line of what the job runs.
 */
export function jobTitle(job: WireWaitJob): string {
	const intent = firstLine(job.intent);
	if (intent !== "") return intent;
	if (job.type === "task") return job.id;
	return jobLabel(job) || job.id;
}
