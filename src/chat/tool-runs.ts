import type { Block, ChatItem, ToolItem } from "../state";

/** One consolidated run: a maximal contiguous sequence of tool calls,
 *  collapsed into a single expandable transcript row. An immediately
 *  preceding assistant suffix that carries thinking is folded in (its
 *  thinking blocks, turn count and durations); a thinking-less assistant
 *  suffix is left untouched and never becomes a run member. */
export interface Run {
	key: number; // id of the run's FIRST TOOL item
	tools: ToolItem[]; // tool members, stream order
	thinking: Block[]; // thinking folded in from consumed assistants, stream order
	consumedAssistantIds: number[]; // assistant messages whose thinking was folded in
	turnCount: number; // consumed assistant messages
	requestCount: number; // tool calls (== tool requests)
	errorCount: number; // tool calls with status "error"
	durationMs: number; // Σ duration of consumed assistants; absent/NaN/negative → 0
	running: boolean; // any tool still "running"
}

/**
 * Walk items in stream order, coalescing each maximal contiguous sequence of
 * TOOL items into one run. Only the maximal contiguous suffix of assistant
 * items immediately before a run's first tool is eligible to be folded in, and
 * only when that suffix contains at least one thinking block; otherwise the
 * suffix is left untouched. Any other item (user, bash, compaction, notice)
 * breaks the current run and clears the pending assistant suffix. Assistant
 * items never become run members, and a trailing assistant suffix with no
 * following tools is never consumed. Empty input yields no runs.
 */
export function groupToolRuns(items: ChatItem[]): Run[] {
	const runs: Run[] = [];
	let tools: ToolItem[] = [];
	let key = 0;
	let pending: Extract<ChatItem, { kind: "assistant" }>[] = [];

	const pendingHasThinking = () => pending.some((a) => a.blocks.some((b) => b.kind === "thinking"));

	const consumePending = () => {
		const thinking: Block[] = [];
		const consumedAssistantIds: number[] = [];
		let turnCount = 0;
		let durationMs = 0;
		for (const a of pending) {
			turnCount++;
			consumedAssistantIds.push(a.id);
			const d = a.duration;
			if (typeof d === "number" && Number.isFinite(d) && d >= 0) durationMs += d;
			for (const b of a.blocks) if (b.kind === "thinking") thinking.push(b);
		}
		return { thinking, consumedAssistantIds, turnCount, durationMs };
	};

	const flushRun = () => {
		if (tools.length === 0) return; // nothing to emit; leave pending for callers
		let thinking: Block[] = [];
		let consumedAssistantIds: number[] = [];
		let turnCount = 0;
		let durationMs = 0;
		if (pendingHasThinking()) {
			const c = consumePending();
			thinking = c.thinking;
			consumedAssistantIds = c.consumedAssistantIds;
			turnCount = c.turnCount;
			durationMs = c.durationMs;
		}
		let requestCount = 0;
		let errorCount = 0;
		let running = false;
		for (const t of tools) {
			requestCount++;
			if (t.status === "error") errorCount++;
			if (t.status === "running") running = true;
		}
		runs.push({
			key,
			tools,
			thinking,
			consumedAssistantIds,
			turnCount,
			requestCount,
			errorCount,
			durationMs,
			running,
		});
		tools = [];
		key = 0;
		pending = [];
	};

	for (const item of items) {
		if (item.kind === "tool") {
			if (tools.length === 0) key = item.id;
			tools.push(item);
		} else if (item.kind === "assistant") {
			flushRun(); // an assistant after a run's tools ends that run and starts a new suffix
			pending.push(item);
		} else {
			flushRun(); // breakers close the run and clear the pending suffix
			pending = [];
		}
	}
	flushRun();
	return runs;
}
