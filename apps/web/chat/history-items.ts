import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ChatItem, ToolItem } from "../state";
import { advisorNotesOf } from "../store/slices/advisor";
import { guestPromptOf } from "../store/slices/collab";
import { compactionItemOf } from "../store/compaction-view";
import { extractText, scanImages } from "#lib/wire/tool-result";
import { isAbortRelabelable, toolResultStatus } from "./tool-interrupt";
import { assistantBlocks, capTail, tabsToSpaces, userText } from "../store/chat";
import type { UsageLike } from "../usage/usage";
import { promptTimestamp } from "./turn-usage";

/** Tail kept of a tool result or shell run's output when a settled transcript is built. */
export const TOOL_OUTPUT_CAP = 8000;

/** What one `append` produced. */
export interface HistoryAppend {
	/** Items created by this call, in transcript order. */
	items: ChatItem[];
	/**
	 * Tool items created by an EARLIER call that this call's results settled
	 * (already mutated in place). Items created and settled within the same
	 * call are not listed: they were never emitted yet.
	 */
	patched: ToolItem[];
}

/**
 * Incremental AgentMessage -> ChatItem conversion shared by the main session
 * history and the subagent transcript. Feed messages in order, in as many
 * `append` calls as needed: the call/result pairing map persists, so a result
 * landing in a later call settles the ToolItem emitted earlier (mutated in
 * place, identity preserved) instead of creating a duplicate.
 */
export interface HistoryBuilder {
	append(messages: readonly AgentMessage[]): HistoryAppend;
}

/**
 * `nextId` allocates item ids; callers whose items live in one list pass their
 * own sequence (main shares the store's transcript sequence).
 */
export function createHistoryBuilder(nextId: () => number = sequence()): HistoryBuilder {
	// First tool item per toolCallId (the store's findToolIndex semantics).
	const tools = new Map<string, ToolItem>();
	// Tool items of the closest assistant message that made calls in the current turn: what an aborted message interrupts.
	let lastCalls: ToolItem[] = [];
	return {
		append(messages) {
			const items: ChatItem[] = [];
			const fresh = new Set<ToolItem>();
			const patched = new Set<ToolItem>();
			for (const msg of messages) {
				if (msg.role === "user") {
					const images = scanImages(msg.content);
					lastCalls = [];
					const stamp = promptTimestamp(msg);
					items.push({
						kind: "user",
						id: nextId(),
						text: userText(msg.content),
						...(images.length > 0 ? { images } : {}),
						...(stamp !== undefined ? { timestamp: stamp } : {}),
					});
				} else if (msg.role === "assistant") {
					if (msg.stopReason === "aborted") {
						// Relabel before this message's own calls join `lastCalls`. A tool item
						// emitted by an earlier append is mutated in place and handed back as patched.
						for (const item of lastCalls) {
							if (!isAbortRelabelable(item)) continue;
							item.status = "interrupted";
							if (!fresh.has(item)) patched.add(item);
						}
					}
					const meta = msg as {
						usage?: UsageLike;
						ttft?: number;
						duration?: number;
						completedAt?: number;
						stopReason?: string;
					};
					items.push({
						kind: "assistant",
						id: nextId(),
						blocks: assistantBlocks(msg.content),
						usage: meta.usage,
						ttft: meta.ttft,
						duration: meta.duration,
						...(meta.completedAt !== undefined ? { completedAt: meta.completedAt } : {}),
						...(meta.stopReason === "aborted" ? { interrupted: true } : {}),
					});
					const calls: ToolItem[] = [];
					for (const c of msg.content) {
						if (c.type !== "toolCall") continue;
						const item: ToolItem = {
							kind: "tool",
							id: nextId(),
							toolCallId: c.id,
							name: c.name,
							args: c.arguments ?? {},
							// No result yet means the call is still in flight (a pending ask, say);
							// the matching toolResult settles it, now or in a later append.
							status: "running",
							output: "",
						};
						if (!tools.has(c.id)) tools.set(c.id, item);
						fresh.add(item);
						calls.push(item);
						items.push(item);
					}
					if (calls.length > 0) lastCalls = calls;
				} else if (msg.role === "toolResult") {
					const output = capTail(tabsToSpaces(extractText(msg)), TOOL_OUTPUT_CAP);
					const status = toolResultStatus(msg.isError, msg.details);
					const images = scanImages(msg);
					const item = tools.get(msg.toolCallId);
					if (item) {
						item.output = output;
						item.status = status;
						if (images.length > 0) item.images = images;
						item.details = msg.details;
						if (!fresh.has(item)) patched.add(item);
					} else {
						const unmatched: ToolItem = {
							kind: "tool",
							id: nextId(),
							toolCallId: msg.toolCallId,
							name: msg.toolName,
							args: null,
							status,
							output,
							...(images.length > 0 ? { images } : {}),
							details: msg.details,
						};
						tools.set(msg.toolCallId, unmatched);
						fresh.add(unmatched);
						items.push(unmatched);
					}
				} else if (msg.role === "bashExecution" || msg.role === "pythonExecution") {
					// `!`/`$` runs: the same card the live call renders, settled.
					items.push({
						kind: "bash",
						id: nextId(),
						command: msg.role === "bashExecution" ? msg.command : msg.code,
						dimmed: msg.excludeFromContext === true,
						lang: msg.role === "bashExecution" ? "bash" : "python",
						status: "done",
						output: capTail(msg.output, TOOL_OUTPUT_CAP),
						exitCode: msg.exitCode ?? null,
						truncated: msg.truncated,
					});
				} else if (msg.role === "compactionSummary") {
					// The settled divider for a compaction boundary (see compaction-view).
					const card = compactionItemOf(msg);
					if (card !== null) items.push({ ...card, id: nextId() });
				} else {
					// Advisor cards render inline like the TUI; other custom/developer
					// messages stay hidden.
					const notes = advisorNotesOf(msg);
					if (notes !== null) items.push({ kind: "advisor", id: nextId(), notes });
					const guest = guestPromptOf(msg);
					if (guest !== null) items.push({ kind: "guestPrompt", id: nextId(), ...guest });
				}
			}
			return { items, patched: [...patched] };
		},
	};
}

function sequence(): () => number {
	let next = 1;
	return () => next++;
}
