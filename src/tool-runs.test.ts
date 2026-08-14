import { describe, expect, test } from "bun:test";
import type { Block, ChatItem, ToolItem } from "./state";
import { groupChatRows, type ChatRow, type Cycle, type CycleMember } from "./tool-runs";

function tool(id: number, name: string): ToolItem {
	return { kind: "tool", id, toolCallId: `t${id}`, name, args: null, status: "done", output: "" };
}

function assistant(id: number, blocks: Block[]): ChatItem {
	return { kind: "assistant", id, blocks };
}

function thinking(text: string): Block {
	return { kind: "thinking", text };
}

function text(text: string): Block {
	return { kind: "text", text };
}

function toolMember(id: number, name: string): CycleMember {
	return { kind: "tool", item: tool(id, name) };
}

function thinkMember(block: Block): CycleMember {
	return { kind: "thinking", block };
}

/** Expected cycle row, built from the ordered member sequence (tools and
 *  thinking interleaved as they occurred); tools/thinking are derived so the
 *  assertion also pins the interleaving order. */
function cycleRow(key: number, members: CycleMember[], assistantIds: number[]): ChatRow {
	const cycle: Cycle = {
		key,
		tools: members.filter((m): m is Extract<CycleMember, { kind: "tool" }> => m.kind === "tool").map(m => m.item),
		thinking: members.filter((m): m is Extract<CycleMember, { kind: "thinking" }> => m.kind === "thinking").map(m => m.block),
		assistantIds,
		members,
	};
	return { kind: "cycle", ...cycle };
}

function itemRow(item: ChatItem): ChatRow {
	return { kind: "item", key: item.id, item };
}

describe("groupChatRows", () => {
	test("live-order cycle: tools then a thinking assistant coalesce into one cycle", () => {
		const items = [tool(1, "read"), tool(2, "read"), tool(3, "glob"), assistant(4, [thinking("hmm"), text("ok")])];
		const rows = groupChatRows(items);
		expect(rows).toHaveLength(1);
		expect(rows).toEqual([
			cycleRow(1, [toolMember(1, "read"), toolMember(2, "read"), toolMember(3, "glob"), thinkMember(thinking("hmm"))], [4]),
		]);
	});

	test("history-order cycle: a thinking assistant before tools still forms one cycle", () => {
		const items = [assistant(1, [thinking("hmm")]), tool(2, "read"), tool(3, "glob")];
		const rows = groupChatRows(items);
		expect(rows).toEqual([cycleRow(1, [thinkMember(thinking("hmm")), toolMember(2, "read"), toolMember(3, "glob")], [1])]);
	});

	test("tools only: one cycle with empty thinking and assistantIds", () => {
		const items = [tool(1, "read"), tool(2, "glob"), tool(3, "edit")];
		const rows = groupChatRows(items);
		expect(rows).toEqual([cycleRow(1, [toolMember(1, "read"), toolMember(2, "glob"), toolMember(3, "edit")], [])]);
	});

	test("a multi-turn loop merges into one cycle with interleaved members", () => {
		const items = [
			tool(1, "read"),
			tool(2, "glob"),
			assistant(3, [thinking("one")]),
			tool(4, "read"),
			tool(5, "edit"),
			assistant(6, [thinking("two")]),
		];
		const rows = groupChatRows(items);
		expect(rows).toHaveLength(1);
		expect(rows).toEqual([
			cycleRow(
				1,
				[toolMember(1, "read"), toolMember(2, "glob"), thinkMember(thinking("one")), toolMember(4, "read"), toolMember(5, "edit"), thinkMember(thinking("two"))],
				[3, 6],
			),
		]);
	});

	test("a lone thinking assistant is an item row, not a cycle", () => {
		const a = assistant(1, [thinking("hmm")]);
		expect(groupChatRows([a])).toEqual([itemRow(a)]);
	});

	test("a thinking-less assistant breaks the cycle", () => {
		const a = assistant(3, [text("x")]);
		const rows = groupChatRows([tool(1, "read"), tool(2, "glob"), a, tool(4, "edit")]);
		expect(rows).toEqual([
			cycleRow(1, [toolMember(1, "read"), toolMember(2, "glob")], []),
			itemRow(a),
			cycleRow(4, [toolMember(4, "edit")], []),
		]);
	});

	test("a user item breaks the cycle", () => {
		const user: ChatItem = { kind: "user", id: 3, text: "hi" };
		const rows = groupChatRows([tool(1, "read"), tool(2, "glob"), user, tool(4, "edit")]);
		expect(rows).toEqual([
			cycleRow(1, [toolMember(1, "read"), toolMember(2, "glob")], []),
			itemRow(user),
			cycleRow(4, [toolMember(4, "edit")], []),
		]);
	});

	test("a bash item breaks the cycle", () => {
		const bash: ChatItem = { kind: "bash", id: 3, command: "x", dimmed: false, lang: "bash", status: "done", output: "", exitCode: 0, truncated: false };
		const rows = groupChatRows([tool(1, "read"), tool(2, "glob"), bash, tool(4, "edit")]);
		expect(rows).toEqual([
			cycleRow(1, [toolMember(1, "read"), toolMember(2, "glob")], []),
			itemRow(bash),
			cycleRow(4, [toolMember(4, "edit")], []),
		]);
	});

	test("a notice breaks the cycle", () => {
		const notice: ChatItem = { kind: "notice", id: 3, level: "info", message: "m" };
		const rows = groupChatRows([tool(1, "read"), tool(2, "glob"), notice, tool(4, "edit")]);
		expect(rows).toEqual([
			cycleRow(1, [toolMember(1, "read"), toolMember(2, "glob")], []),
			itemRow(notice),
			cycleRow(4, [toolMember(4, "edit")], []),
		]);
	});

	test("a compaction breaks the cycle", () => {
		const compaction: ChatItem = { kind: "compaction", id: 3, action: "c", skipped: false, aborted: false, willRetry: false };
		const rows = groupChatRows([tool(1, "read"), tool(2, "glob"), compaction, tool(4, "edit")]);
		expect(rows).toEqual([
			cycleRow(1, [toolMember(1, "read"), toolMember(2, "glob")], []),
			itemRow(compaction),
			cycleRow(4, [toolMember(4, "edit")], []),
		]);
	});

	test("a single tool forms one cycle", () => {
		const rows = groupChatRows([tool(7, "read")]);
		expect(rows).toEqual([cycleRow(7, [toolMember(7, "read")], [])]);
	});

	test("empty input yields no rows", () => {
		expect(groupChatRows([])).toEqual([]);
	});

	test("text blocks never enter a cycle's thinking, and thinking keeps its block order", () => {
		const items = [assistant(1, [thinking("a"), text("visible"), thinking("b")]), tool(2, "read")];
		const rows = groupChatRows(items);
		expect(rows).toHaveLength(1);
		expect(rows).toEqual([
			cycleRow(1, [thinkMember(thinking("a")), thinkMember(thinking("b")), toolMember(2, "read")], [1]),
		]);
	});
});
