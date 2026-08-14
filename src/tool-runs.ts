import type { Block, ChatItem, ToolItem } from "./state";

/** One member of a cycle in original stream order: a tool call or a thinking block. */
export type CycleMember =
	| { kind: "tool"; item: ToolItem }
	| { kind: "thinking"; block: Block };

/** One turn's tool calls plus the thinking blocks of its assistant messages;
 *  `key` is the id of the cycle's first member. */
export interface Cycle {
	key: number;
	tools: ToolItem[];
	thinking: Block[];
	assistantIds: number[];
	/** All members in original stream order (tools and thinking interleaved). */
	members: CycleMember[];
}

/** One grouped chat row: a tool/thinking cycle or a single standalone item. */
export type ChatRow =
	| ({ kind: "cycle" } & Cycle)
	| { kind: "item"; key: number; item: ChatItem };

/**
 * Walk items in stream order, coalescing consecutive tool items and
 * thinking-bearing assistant items into one cycle row. A pending group with
 * no tools (thinking-only assistants) flushes as individual item rows; any
 * other item (user, bash, compaction, notice, or a thinking-less assistant)
 * breaks the cycle and becomes its own item row. Empty input yields no rows.
 */
export function groupChatRows(items: ChatItem[]): ChatRow[] {
	const rows: ChatRow[] = [];
	let pending: ChatItem[] = [];
	let tools: ToolItem[] = [];
	let thinking: Block[] = [];
	let assistantIds: number[] = [];
	let members: CycleMember[] = [];
	let key = 0;
	const flushPending = () => {
		if (pending.length === 0) return;
		if (tools.length > 0) {
			rows.push({ kind: "cycle", key, tools, thinking, assistantIds, members });
		} else {
			for (const item of pending) rows.push({ kind: "item", key: item.id, item });
		}
		pending = [];
		tools = [];
		thinking = [];
		assistantIds = [];
		members = [];
	};
	for (const item of items) {
		const joins = item.kind === "tool" || (item.kind === "assistant" && item.blocks.some(b => b.kind === "thinking"));
		if (!joins) {
			flushPending();
			rows.push({ kind: "item", key: item.id, item });
			continue;
		}
		if (pending.length === 0) key = item.id;
		pending.push(item);
		if (item.kind === "tool") {
			tools.push(item);
			members.push({ kind: "tool", item });
		} else if (item.kind === "assistant") {
			assistantIds.push(item.id);
			for (const b of item.blocks) {
				if (b.kind === "thinking") {
					thinking.push(b);
					members.push({ kind: "thinking", block: b });
				}
			}
		}
	}
	flushPending();
	return rows;
}
