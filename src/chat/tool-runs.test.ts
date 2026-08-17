import { describe, expect, test } from "bun:test";
import type { Block, ChatItem, ToolItem, ToolStatus } from "../state";
import { groupAssistantRuns, type Run } from "./tool-runs";

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

/** Expected run, derived from the ordered member sequence so assertions pin
 *  stream order and the aggregated counters in one place. */
function run(key: number, items: Array<Extract<ChatItem, { kind: "assistant" }> | ToolItem>): Run {
	return {
		key,
		items,
		tools: items.filter((it): it is ToolItem => it.kind === "tool"),
		thinking: items.flatMap((it) =>
			it.kind === "assistant" ? it.blocks.filter((b) => b.kind === "thinking") : [],
		),
		turnCount: items.filter((it) => it.kind === "assistant").length,
		requestCount: items.filter((it) => it.kind === "tool").length,
		errorCount: items.filter((it): it is ToolItem => it.kind === "tool" && it.status === "error")
			.length,
		durationMs: items.reduce(
			(sum, it) =>
				it.kind === "assistant" &&
				typeof it.duration === "number" &&
				Number.isFinite(it.duration) &&
				it.duration >= 0
					? sum + it.duration
					: sum,
			0,
		),
		running: items.some((it): it is ToolItem => it.kind === "tool" && it.status === "running"),
	};
}

describe("groupAssistantRuns", () => {
	test("consecutive assistant turns and tools merge into one run", () => {
		const items = [
			assistant(1, [thinking("hmm"), text("ok")]),
			tool(2, "read"),
			tool(3, "glob"),
			assistant(4, [text("done")]),
		];
		const runs = groupAssistantRuns(items);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.key).toBe(1);
		expect(runs[0]!.items).toEqual(items);
		expect(runs[0]!.thinking).toEqual([thinking("hmm")]);
		expect(runs[0]!.turnCount).toBe(2);
		expect(runs[0]!.requestCount).toBe(2);
		expect(runs[0]!.errorCount).toBe(0);
		expect(runs[0]!.running).toBe(false);
		expect(runs[0]!.durationMs).toBe(0);
	});

	test("a user item breaks the run", () => {
		const items = [tool(1, "read"), user(2), assistant(3, [text("hi")])];
		expect(groupAssistantRuns(items)).toEqual([
			run(1, [tool(1, "read")]),
			run(3, [assistant(3, [text("hi")])]),
		]);
		// breakers never join a run and never produce empty runs
		expect(groupAssistantRuns([user(4), user(5), tool(6, "read")])).toEqual([
			run(6, [tool(6, "read")]),
		]);
	});

	test("a bash item breaks the run", () => {
		const items = [tool(1, "read"), bash(2), tool(3, "glob")];
		expect(groupAssistantRuns(items)).toEqual([
			run(1, [tool(1, "read")]),
			run(3, [tool(3, "glob")]),
		]);
	});

	test("a compaction item breaks the run", () => {
		const items = [assistant(1, [text("hi")]), compaction(2), assistant(3, [text("bye")])];
		expect(groupAssistantRuns(items)).toEqual([
			run(1, [assistant(1, [text("hi")])]),
			run(3, [assistant(3, [text("bye")])]),
		]);
	});

	test("a notice item breaks the run", () => {
		const items = [tool(1, "read"), notice(2), tool(3, "edit")];
		expect(groupAssistantRuns(items)).toEqual([
			run(1, [tool(1, "read")]),
			run(3, [tool(3, "edit")]),
		]);
	});

	test("error and running statuses are counted", () => {
		const items = [
			tool(1, "read"),
			tool(2, "glob", "error"),
			tool(3, "edit", "running"),
			tool(4, "bash", "error"),
		];
		const runs = groupAssistantRuns(items);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.requestCount).toBe(4);
		expect(runs[0]!.errorCount).toBe(2); // the "done" tool never counts as err
		expect(runs[0]!.running).toBe(true);
		expect(runs[0]!.tools).toEqual(items);
	});

	test("duration sums assistant durations; missing, negative, and NaN contribute zero", () => {
		const items = [
			assistant(1, [text("a")], 1200),
			assistant(2, [text("b")]),
			assistant(3, [text("c")], 3400),
			assistant(4, [text("d")], -100),
			assistant(5, [text("e")], NaN),
		];
		const runs = groupAssistantRuns(items);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.durationMs).toBe(4600);
	});

	test("a tools-only run has durationMs 0", () => {
		expect(groupAssistantRuns([tool(1, "read")])[0]!.durationMs).toBe(0);
	});

	test("thinking keeps block order and text blocks never count", () => {
		const runs = groupAssistantRuns([assistant(1, [thinking("a"), text("v"), thinking("b")])]);
		expect(runs).toHaveLength(1);
		expect(runs[0]!.thinking).toEqual([thinking("a"), thinking("b")]);
	});

	test("a lone text-only assistant is a run of one", () => {
		const a = assistant(1, [text("hi")]);
		const runs = groupAssistantRuns([a]);
		expect(runs).toEqual([run(1, [a])]);
		expect(runs[0]!.turnCount).toBe(1);
		expect(runs[0]!.requestCount).toBe(0);
	});

	test("a thinking-less assistant stays in the run", () => {
		const items = [tool(1, "read"), assistant(2, [text("ok")]), tool(3, "edit")];
		expect(groupAssistantRuns(items)).toEqual([run(1, items)]);
	});

	test("a tools-only run is allowed defensively", () => {
		const runs = groupAssistantRuns([tool(1, "read")]);
		expect(runs).toEqual([run(1, [tool(1, "read")])]);
		expect(runs[0]!.turnCount).toBe(0);
		expect(runs[0]!.requestCount).toBe(1);
	});

	test("empty input yields no runs", () => {
		expect(groupAssistantRuns([])).toEqual([]);
	});

	test("a multi-turn loop merges into one run, keeping stream order", () => {
		const items = [
			assistant(1, [thinking("one"), text("go")]),
			tool(2, "read"),
			tool(3, "glob"),
			assistant(4, [thinking("two"), text("next")]),
			tool(5, "edit"),
		];
		const runs = groupAssistantRuns(items);
		expect(runs).toEqual([run(1, items)]);
		expect(runs[0]!.thinking).toEqual([thinking("one"), thinking("two")]);
		expect(runs[0]!.turnCount).toBe(2);
		expect(runs[0]!.requestCount).toBe(3);
	});
});
