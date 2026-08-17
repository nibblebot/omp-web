import type { Block, ChatItem, ToolItem } from "../state";

/** One consolidated run: a maximal contiguous sequence of assistant messages
 *  and tool calls, collapsed into a single expandable transcript row. */
export interface Run {
	key: number; // id of the run's first member
	items: Array<Extract<ChatItem, { kind: "assistant" }> | ToolItem>; // members in original stream order (assistant + tool only)
	tools: ToolItem[]; // tool calls, stream order
	thinking: Block[]; // thinking blocks only (text blocks excluded), stream order
	turnCount: number; // assistant messages (== model requests)
	requestCount: number; // tool calls (tool requests)
	errorCount: number; // tool calls with status "error"
	durationMs: number; // Σ assistant.duration (ms); absent/NaN/negative → 0
	running: boolean; // any tool still "running"
}

/**
 * Walk items in stream order, coalescing consecutive assistant and tool items
 * into one run. Any other item (user, bash, compaction, notice) breaks the
 * span and never joins a run. Empty input yields no runs.
 */
export function groupAssistantRuns(items: ChatItem[]): Run[] {
	const runs: Run[] = [];
	let pending: Array<Extract<ChatItem, { kind: "assistant" }> | ToolItem> = [];
	let tools: ToolItem[] = [];
	let thinking: Block[] = [];
	let turnCount = 0;
	let requestCount = 0;
	let errorCount = 0;
	let durationMs = 0;
	let running = false;
	let key = 0;
	const flushPending = () => {
		if (pending.length === 0) return;
		runs.push({
			key,
			items: pending,
			tools,
			thinking,
			turnCount,
			requestCount,
			errorCount,
			durationMs,
			running,
		});
		pending = [];
		tools = [];
		thinking = [];
		turnCount = 0;
		requestCount = 0;
		errorCount = 0;
		durationMs = 0;
		running = false;
	};
	for (const item of items) {
		if (item.kind !== "assistant" && item.kind !== "tool") {
			flushPending();
			continue;
		}
		if (pending.length === 0) key = item.id;
		pending.push(item);
		if (item.kind === "tool") {
			tools.push(item);
			requestCount++;
			if (item.status === "error") errorCount++;
			if (item.status === "running") running = true;
		} else if (item.kind === "assistant") {
			turnCount++;
			const duration = item.duration;
			if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0)
				durationMs += duration;
			for (const b of item.blocks) {
				if (b.kind === "thinking") thinking.push(b);
			}
		}
	}
	flushPending();
	return runs;
}
