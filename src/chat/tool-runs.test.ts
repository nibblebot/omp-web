import { describe, expect, test } from "bun:test";
import type { Block, ChatItem, ToolItem, ToolStatus } from "../state";
import { groupToolRuns, type Run } from "./tool-runs";

function tool(id: number, name: string, status: ToolStatus = "done"): ToolItem {
	return { kind: "tool", id, toolCallId: `t${id}`, name, args: null, status, output: "" };
}

function assistant(
	id: number,
	blocks: Block[],
	duration?: number,
): Extract<ChatItem, { kind: "assistant" }> {
	return { kind: "assistant", id, blocks, ...(duration === undefined ? {} : { duration }) };
}

function thinking(text: string): Block {
	return { kind: "thinking", text };
}

function text(text: string): Block {
	return { kind: "text", text };
}

function user(id: number): ChatItem {
	return { kind: "user", id, text: "" };
}

function bash(id: number): ChatItem {
	return {
		kind: "bash",
		id,
		command: "",
		dimmed: false,
		lang: "bash",
		status: "done",
		output: "",
		exitCode: 0,
		truncated: false,
	};
}

function compaction(id: number): ChatItem {
	return {
		kind: "compaction",
		id,
		action: "compact",
		skipped: false,
		aborted: false,
		willRetry: false,
	};
}

function notice(id: number): ChatItem {
	return { kind: "notice", id, level: "info", message: "" };
}

/** Expected run. Only tools are members; folded-in assistant data is passed via
 *  opts so assertions pin consumption direction and the aggregated counters. */
function run(
	key: number,
	tools: ToolItem[],
	opts: {
		thinking?: Block[];
		consumedAssistantIds?: number[];
		turnCount?: number;
		durationMs?: number;
	} = {},
): Run {
	return {
		key,
		tools,
		thinking: opts.thinking ?? [],
		consumedAssistantIds: opts.consumedAssistantIds ?? [],
		turnCount: opts.turnCount ?? 0,
		requestCount: tools.filter((t) => t.kind === "tool").length,
		errorCount: tools.filter((t) => t.status === "error").length,
		durationMs: opts.durationMs ?? 0,
		running: tools.some((t) => t.status === "running"),
	};
}

describe("groupToolRuns", () => {
	test("contiguous tools merge into one run; key is the first tool id", () => {
		const items = [tool(1, "read"), tool(2, "glob"), tool(3, "edit")];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([run(1, items)]);
		expect(runs[0]!.key).toBe(1);
		expect(runs[0]!.consumedAssistantIds).toEqual([]);
		expect(runs[0]!.turnCount).toBe(0);
		expect(runs[0]!.durationMs).toBe(0);
	});

	test("a user item breaks a run and a fresh suffix belongs to the next run", () => {
		// assistant(3) after the user must be consumed by tool(4), NOT folded into run[1]
		const items = [tool(1, "read"), user(2), assistant(3, [thinking("h")]), tool(4, "glob")];
		expect(groupToolRuns(items)).toEqual([
			run(1, [tool(1, "read")]),
			run(4, [tool(4, "glob")], {
				thinking: [thinking("h")],
				consumedAssistantIds: [3],
				turnCount: 1,
			}),
		]);
	});

	test("a breaker clears a stale assistant suffix so it is never consumed", () => {
		// assistant(1) precedes the user, so the breaker must drop it entirely
		const items = [assistant(1, [thinking("h")]), user(2), tool(3, "read")];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([run(3, [tool(3, "read")])]);
		expect(runs[0]!.thinking).toEqual([]);
		expect(runs[0]!.consumedAssistantIds).toEqual([]);
		expect(runs[0]!.turnCount).toBe(0);
	});

	test("a bash item breaks the run", () => {
		const items = [tool(1, "read"), bash(2), tool(3, "glob")];
		expect(groupToolRuns(items)).toEqual([run(1, [tool(1, "read")]), run(3, [tool(3, "glob")])]);
	});

	test("a compaction item breaks the run", () => {
		const items = [tool(1, "read"), compaction(2), tool(3, "glob")];
		expect(groupToolRuns(items)).toEqual([run(1, [tool(1, "read")]), run(3, [tool(3, "glob")])]);
	});

	test("a notice item breaks the run", () => {
		const items = [tool(1, "read"), notice(2), tool(3, "glob")];
		expect(groupToolRuns(items)).toEqual([run(1, [tool(1, "read")]), run(3, [tool(3, "glob")])]);
	});

	test("a thinking-bearing suffix is consumed: thinking folded, ids, turns, durations summed", () => {
		const items = [
			assistant(1, [thinking("a"), text("x")], 1200),
			assistant(2, [thinking("b")], NaN),
			assistant(3, [text("no-thinking")], -100),
			assistant(4, [thinking("c")]),
			assistant(5, [thinking("d"), text("y")], 3400),
			tool(6, "read"),
			tool(7, "glob"),
		];
		const runs = groupToolRuns(items);
		expect(runs).toHaveLength(1);
		expect(runs[0]).toEqual(
			run(6, [tool(6, "read"), tool(7, "glob")], {
				thinking: [thinking("a"), thinking("b"), thinking("c"), thinking("d")],
				consumedAssistantIds: [1, 2, 3, 4, 5],
				turnCount: 5,
				durationMs: 4600, // NaN, negative, and missing contribute 0
			}),
		);
	});

	test("a thinking-less suffix before tools is NOT consumed", () => {
		const items = [assistant(1, [text("hi")], 500), tool(2, "read")];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([run(2, [tool(2, "read")])]);
		expect(runs[0]!.thinking).toEqual([]);
		expect(runs[0]!.consumedAssistantIds).toEqual([]);
		expect(runs[0]!.turnCount).toBe(0);
		expect(runs[0]!.durationMs).toBe(0);
	});

	test("assistant with thinking but no following tools yields no run", () => {
		expect(groupToolRuns([assistant(1, [thinking("h")])])).toEqual([]);
		expect(groupToolRuns([assistant(1, [thinking("h")]), assistant(2, [thinking("g")])])).toEqual(
			[],
		);
	});

	test("a trailing assistant after a run is never consumed", () => {
		const items = [tool(1, "read"), assistant(2, [thinking("h")], 500)];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([run(1, [tool(1, "read")])]);
		expect(runs[0]!.thinking).toEqual([]);
		expect(runs[0]!.consumedAssistantIds).toEqual([]);
		expect(runs[0]!.turnCount).toBe(0);
		expect(runs[0]!.durationMs).toBe(0);
	});

	test("tool,tool,assistant(thinking+text),tool -> two runs, second consumes the assistant", () => {
		const items = [
			tool(1, "read"),
			tool(2, "glob"),
			assistant(3, [thinking("h"), text("payload")]),
			tool(4, "edit"),
		];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([
			run(1, [tool(1, "read"), tool(2, "glob")]),
			run(4, [tool(4, "edit")], {
				thinking: [thinking("h")],
				consumedAssistantIds: [3],
				turnCount: 1,
			}),
		]);
		expect(runs[1]!.thinking).toEqual([thinking("h")]); // text never enters the run
		expect(runs[1]!.thinking).not.toContain(text("payload"));
	});

	test("text blocks never enter thinking; multiple thinking blocks keep stream order", () => {
		const items = [assistant(1, [thinking("b"), text("v"), thinking("a")]), tool(2, "read")];
		const runs = groupToolRuns(items);
		expect(runs[0]!.thinking).toEqual([thinking("b"), thinking("a")]);
		expect(runs[0]!.thinking).not.toContain(text("v"));
	});

	test("error and running statuses are counted; a done tool never counts as err", () => {
		const items = [
			tool(1, "read"),
			tool(2, "glob", "error"),
			tool(3, "edit", "running"),
			tool(4, "bash", "error"),
		];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([run(1, items)]);
		expect(runs[0]!.requestCount).toBe(4);
		expect(runs[0]!.errorCount).toBe(2);
		expect(runs[0]!.running).toBe(true);
	});

	test("lone assistant input yields no runs", () => {
		expect(groupToolRuns([assistant(1, [text("hi")])])).toEqual([]);
		expect(groupToolRuns([assistant(1, [thinking("h")])])).toEqual([]);
	});

	test("empty input yields no runs", () => {
		expect(groupToolRuns([])).toEqual([]);
	});

	test("multiple runs each consume only their own immediately-preceding suffix", () => {
		const items = [
			assistant(1, [thinking("one")], 100),
			tool(2, "read"),
			user(3),
			assistant(4, [thinking("two")], 200),
			tool(5, "glob"),
		];
		expect(groupToolRuns(items)).toEqual([
			run(2, [tool(2, "read")], {
				thinking: [thinking("one")],
				consumedAssistantIds: [1],
				turnCount: 1,
				durationMs: 100,
			}),
			run(5, [tool(5, "glob")], {
				thinking: [thinking("two")],
				consumedAssistantIds: [4],
				turnCount: 1,
				durationMs: 200,
			}),
		]);
	});
});
