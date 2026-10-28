import type { Block, ChatItem, ToolItem } from "../state";
import { effectiveStatus } from "./background-job";
import type { WaitRun } from "./wait-runs";

/** An assistant item that draws no prose: no non-whitespace text block and no
 *  interruption footer (thinking and tool-call blocks do not count). */
export function isProseless(item: Extract<ChatItem, { kind: "assistant" }>): boolean {
	return !item.interrupted && !item.blocks.some((b) => b.kind === "text" && b.text.trim() !== "");
}

/** One consolidated run: a maximal contiguous sequence of tool calls, drawn as
 *  a single summary row (Consolidated tool cards). Prose-less assistant items
 *  between its calls, or at the end of the assistant suffix right before its
 *  first call, are consumed by the run: their thinking, turn count and
 *  durations are folded in and their cards draw nothing. A pre-run suffix that
 *  carries thinking is folded whole (prose-bearing items keep their text, only
 *  the thinking leaves their card). A folded `wait` run counts as one call:
 *  only its first call is a member. */
export interface Run {
	key: number; // id of the run's FIRST TOOL item
	tools: ToolItem[]; // calls, stream order; a wait run is represented by its first call
	thinking: Block[]; // thinking folded in from consumed assistants, stream order
	consumedAssistantIds: number[]; // assistant messages the run consumed
	turnCount: number; // consumed assistant messages
	requestCount: number; // calls (== tool requests)
	errorCount: number; // calls with status "error"
	durationMs: number; // Σ duration of consumed assistants; absent/NaN/negative → 0
	running: boolean; // any call still running (a call parked on a background job counts)
}

/** What a run takes from the assistant items it consumes. */
type Folded = Pick<Run, "thinking" | "consumedAssistantIds" | "turnCount" | "durationMs">;

const NO_WAIT_RUNS: ReadonlyMap<number, WaitRun> = new Map();

/** A lookup of the wait run a call leads. */
export type WaitRunLookup = Pick<ReadonlyMap<number, WaitRun>, "get">;

/** Whether a call is still running; a wait run runs while any of its calls does. */
export function callRunning(item: ToolItem, waitRuns: WaitRunLookup): boolean {
	return (waitRuns.get(item.id)?.items ?? [item]).some(
		(call) => effectiveStatus(call) === "running",
	);
}

/**
 * Walk items in stream order, coalescing each maximal contiguous sequence of
 * TOOL items into one run. An agentic turn (assistant with a tool call, tool,
 * assistant with a tool call, tool, ..., final prose) is ONE run: a prose-less
 * assistant item (only thinking and/or tool-call blocks, or nothing) sitting
 * between two calls of a run is consumed by it and does not break it. An
 * assistant item with visible prose ends the run. A prose-less assistant after
 * a run's last call is not consumed (it may still gain text, and a later call
 * is what proves it belongs to the run); it starts the next suffix instead.
 *
 * Before a run's first call, the maximal contiguous assistant suffix is
 * eligible: when it contains at least one thinking block the whole suffix is
 * consumed (a prose-bearing item then only loses its thinking); otherwise only
 * its trailing prose-less items are. Any other item (user, bash, compaction,
 * notice) breaks the current run and clears the pending suffix. Assistant
 * items never become run members. Empty input yields no runs.
 *
 * `waitRuns` (chat/wait-runs.ts) folds consecutive `wait` calls into one card
 * drawn at the first call: that call stands for the whole run and the later
 * calls are not members. The assistant items between them draw nothing (by the
 * wait-run rule), so they are prose-less and consumed like any other. Omit it
 * to treat every call alone.
 */
export function groupToolRuns(
	items: readonly ChatItem[],
	waitRuns: ReadonlyMap<number, WaitRun> = NO_WAIT_RUNS,
): Run[] {
	type Assistant = Extract<ChatItem, { kind: "assistant" }>;
	const runs: Run[] = [];
	let tools: ToolItem[] = [];
	let key = 0;
	let acc: Folded = { thinking: [], consumedAssistantIds: [], turnCount: 0, durationMs: 0 };
	let pending: Assistant[] = []; // assistant suffix before a run's first call (no run open)
	let gap: Assistant[] = []; // prose-less assistants since the open run's last call

	const take = (a: Assistant) => {
		acc.turnCount++;
		acc.consumedAssistantIds.push(a.id);
		const d = a.duration;
		if (typeof d === "number" && Number.isFinite(d) && d >= 0) acc.durationMs += d;
		for (const b of a.blocks) if (b.kind === "thinking") acc.thinking.push(b);
	};

	// The next call proves the gap sits between calls: the run consumes it.
	const commitGap = () => {
		for (const a of gap) take(a);
		gap = [];
	};

	const startRun = (first: ToolItem) => {
		key = first.id;
		acc = { thinking: [], consumedAssistantIds: [], turnCount: 0, durationMs: 0 };
		let from = pending.length;
		if (pending.some((a) => a.blocks.some((b) => b.kind === "thinking"))) from = 0;
		else while (from > 0 && isProseless(pending[from - 1]!)) from--;
		for (let i = from; i < pending.length; i++) take(pending[i]!);
		pending = [];
	};

	const flushRun = () => {
		if (tools.length === 0) return; // nothing to emit; leave pending for callers
		let errorCount = 0;
		let running = false;
		for (const t of tools) {
			if (t.status === "error") errorCount++;
			if (callRunning(t, waitRuns)) running = true;
		}
		runs.push({ key, tools, ...acc, requestCount: tools.length, errorCount, running });
		tools = [];
		key = 0;
		gap = [];
	};

	for (const item of items) {
		if (item.kind === "tool") {
			const lead = waitRuns.get(item.id)?.items[0];
			if (lead && lead.id !== item.id && tools.at(-1)?.id === lead.id) {
				// A later call of a folded wait run: the run's first call already stands for it.
				commitGap();
				continue;
			}
			if (tools.length === 0) startRun(item);
			else commitGap();
			tools.push(item);
		} else if (item.kind === "assistant") {
			if (tools.length > 0 && isProseless(item)) {
				gap.push(item);
				continue;
			}
			// Prose ends the run; the prose-less items after its last call start the next suffix.
			const dropped = gap;
			gap = [];
			flushRun();
			pending.push(...dropped, item);
		} else {
			flushRun(); // breakers close the run and clear the pending suffix
			pending = [];
		}
	}
	flushRun();
	return runs;
}

/** Every call of the runs mapped to its run, plus the assistant messages whose thinking a run took. */
export interface ToolRunIndex {
	runOf: ReadonlyMap<number, Run>;
	consumedAssistantIds: ReadonlySet<number>;
}

const NO_RUNS: ToolRunIndex = { runOf: new Map(), consumedAssistantIds: new Set() };

/**
 * The runs the transcript draws as summary rows, indexed for its per-item lookups.
 * Empty unless `consolidated` (the Consolidated tool cards mode) and the tool
 * activity is shown: with `hideToolActivity` no call draws, so no run forms and
 * thinking stays on its own assistant card.
 */
export function indexToolRuns(
	items: readonly ChatItem[],
	options: {
		consolidated: boolean;
		hideToolActivity: boolean;
		waitRuns: ReadonlyMap<number, WaitRun>;
	},
): ToolRunIndex {
	if (!options.consolidated || options.hideToolActivity) return NO_RUNS;
	const runOf = new Map<number, Run>();
	const consumedAssistantIds = new Set<number>();
	for (const run of groupToolRuns(items, options.waitRuns)) {
		for (const tool of run.tools) runOf.set(tool.id, run);
		for (const id of run.consumedAssistantIds) consumedAssistantIds.add(id);
	}
	return { runOf, consumedAssistantIds };
}
