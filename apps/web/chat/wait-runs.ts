/**
 * Folding consecutive `wait` calls into one card. An agent that waits again
 * and again (each call returns when one job settles) would stack a card per
 * call; a run is a maximal sequence of such calls with nothing visible in
 * between, and the transcript draws it as one merged card. Everything derives
 * from item fields, so a live stream and a history reload fold the same way.
 * Pure, so the folding stays testable without a DOM.
 */
import type { WireJobWidgetView, WireWaitJob } from "#lib/wire/protocol";
import type { ChatItem, ToolItem } from "../state";
import { formatThinkingForDisplay, hasDisplayableThinking } from "./thinking";
import type { TurnMeta } from "./turn-usage";
import { waitCallOf, type WaitAgent } from "./wait-details";

/** The calls of one run, oldest first; the card renders at the first. */
export interface WaitRun {
	items: ToolItem[];
}

/** The display settings that decide whether an assistant item draws anything. */
export interface WaitFoldOptions {
	/** `hideThinkingBlock`: thinking blocks are omitted. */
	hideThinking: boolean;
	/** `proseOnlyThinking`: fenced code in thinking is elided (may leave a block with nothing to show). */
	proseOnlyThinking: boolean;
	/** `display.showTokenUsage`: an assistant item with usage draws a usage row. */
	showTokenUsage: boolean;
	/** Per-assistant display metadata; an item with a cache-miss marker draws it. */
	turnMeta: ReadonlyMap<number, TurnMeta>;
}

/** Whether an assistant item draws anything: text, thinking that shows under `options`, a usage row or cache-miss marker, or an interruption footer. */
export function assistantShowsContent(
	item: Extract<ChatItem, { kind: "assistant" }>,
	options: WaitFoldOptions,
): boolean {
	if (item.interrupted) return true;
	if (options.showTokenUsage && item.usage !== undefined) return true;
	if (options.turnMeta.get(item.id)?.cacheMissTokens) return true;
	for (const block of item.blocks) {
		if (block.kind === "text") {
			if (block.text.trim() !== "") return true;
			continue;
		}
		if (options.hideThinking) continue;
		const formatted = formatThinkingForDisplay(block.text, options.proseOnlyThinking);
		if (hasDisplayableThinking(block.text, formatted)) return true;
	}
	return false;
}

/** A call that can join a run: it is running or settled, and did not return a peer message (`details.waited`, its own card). */
function foldable(item: ToolItem): boolean {
	// A running call has no result yet, so no message: its live frames never change the fold.
	if (item.status === "running") return true;
	return item.status === "done" && !waitCallOf(item).message;
}

/**
 * Every wait item of the transcript mapped to its run, in one pass. A run
 * grows over consecutive waits separated only by assistant items that draw
 * nothing; a user item, any other item or visible assistant content ends it.
 * A wait that consumed a message, failed or was stopped is a run of its own
 * and ends the one before it. Each item of a run maps to the same `WaitRun`,
 * so the caller renders the card at `run.items[0]` and nothing for the rest.
 */
export function buildWaitRuns(
	items: readonly ChatItem[],
	options: WaitFoldOptions,
): Map<number, WaitRun> {
	const runs = new Map<number, WaitRun>();
	let open: WaitRun | undefined;
	for (const item of items) {
		if (item.kind === "tool" && item.name === "wait") {
			if (foldable(item)) {
				if (open) open.items.push(item);
				else open = { items: [item] };
				runs.set(item.id, open);
			} else {
				runs.set(item.id, { items: [item] });
				open = undefined;
			}
			continue;
		}
		// An assistant item that draws nothing leaves a run open; it is only read while one is.
		if (item.kind === "assistant" && (!open || !assistantShowsContent(item, options))) continue;
		open = undefined;
	}
	return runs;
}

/** One job of a run: its latest state, the widget it last showed, and when it settled. */
export interface RunJob {
	job: WireWaitJob;
	/** The widget the latest settled wait that listed the job kept. */
	widget?: WireJobWidgetView;
	/** Index (0 is the first wait of the run) of the wait that first listed the job as settled; absent while it runs. */
	settledAt?: number;
	/** Epoch ms of the live frame the job's state comes from; its clock advances from it while it runs. */
	at?: number;
}

/** A run's merged card input. */
export interface WaitRunView {
	/** Every job any wait of the run listed, in display order. */
	jobs: RunJob[];
	/** Running agents with no job row, as the latest wait reported them. */
	agents: WaitAgent[];
	/** Waits in the run. */
	waits: number;
	/** Waits cut short by a message or completion notice. */
	interruptions: number;
	/** Waits that found nothing to wait for. */
	empties: number;
}

const STATUS_ORDER: Record<WireWaitJob["status"], number> = {
	running: 0,
	failed: 1,
	cancelled: 2,
	completed: 3,
};

/** Running first (longest-running first), then failed, cancelled, completed; the most recently settled first within a status. */
export function sortRunJobs(jobs: readonly RunJob[]): RunJob[] {
	return [...jobs].sort(
		(a, b) =>
			STATUS_ORDER[a.job.status] - STATUS_ORDER[b.job.status] ||
			(b.settledAt ?? 0) - (a.settledAt ?? 0) ||
			b.job.durationMs - a.job.durationMs,
	);
}

/**
 * Merge a run's calls. A job takes its latest state from the latest wait that
 * listed it, so one that settled in an early wait stays listed after later
 * waits stop mentioning it; a running last wait overrides from its live frame.
 * Agents are the latest wait's alone.
 */
export function mergeWaitRun(items: readonly ToolItem[]): WaitRunView {
	const merged = new Map<string, RunJob>();
	let agents: WaitAgent[] = [];
	let interruptions = 0;
	let empties = 0;
	items.forEach((item, index) => {
		const call = waitCallOf(item);
		if (call.interrupted) interruptions++;
		else if (item.status !== "running" && call.jobs.length === 0 && call.agents.length === 0)
			empties++;
		agents = call.agents;
		for (const job of call.jobs) {
			const prev = merged.get(job.id);
			const widget = call.widgets.get(job.id) ?? prev?.widget;
			const settledAt = job.status === "running" ? undefined : (prev?.settledAt ?? index);
			merged.set(job.id, {
				job,
				...(widget ? { widget } : {}),
				...(settledAt !== undefined ? { settledAt } : {}),
				...(call.live && job.status === "running" && call.at !== undefined ? { at: call.at } : {}),
			});
		}
	});
	return {
		jobs: sortRunJobs([...merged.values()]),
		agents,
		waits: items.length,
		interruptions,
		empties,
	};
}

/** Run time to show for a job: a running job of a live frame keeps counting from the frame's arrival. */
export function jobElapsedMs(entry: Pick<RunJob, "job" | "at">, now: number): number {
	return entry.job.status === "running" && entry.at !== undefined
		? entry.job.durationMs + Math.max(0, now - entry.at)
		: entry.job.durationMs;
}

/** The header summary the SDK shows: `waiting on 2 of 3 jobs`, `3 jobs settled`, or the agents when no job. */
export function waitSummary(view: Pick<WaitRunView, "jobs" | "agents">): string {
	const { jobs, agents } = view;
	const noun = jobs.length === 1 ? "job" : "jobs";
	if (jobs.length === 0) {
		return `${agents.length} running agent${agents.length === 1 ? "" : "s"}, no jobs`;
	}
	const running = jobs.filter((entry) => entry.job.status === "running").length;
	if (running === 0) return `${jobs.length} ${noun} settled`;
	return running === jobs.length
		? `waiting on ${jobs.length} ${noun}`
		: `waiting on ${running} of ${jobs.length} ${noun}`;
}

/** The muted footer line of a run's marks: interruptions and waits that found nothing; undefined without any. */
export function waitMarksText(
	view: Pick<WaitRunView, "interruptions" | "empties">,
): string | undefined {
	const parts: string[] = [];
	if (view.interruptions > 0)
		parts.push(
			view.interruptions === 1
				? "interrupted by a message"
				: `interrupted by a message ${view.interruptions} times`,
		);
	if (view.empties > 0)
		parts.push(
			view.empties === 1 ? "nothing to wait for" : `nothing to wait for ${view.empties} times`,
		);
	return parts.length > 0 ? parts.join(" \u00b7 ") : undefined;
}
