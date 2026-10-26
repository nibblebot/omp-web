import { describe, expect, test } from "bun:test";
import type { Block, ChatItem, ToolItem, ToolStatus } from "../../state";
import { groupToolRuns, indexToolRuns, type Run } from "../../chat/tool-runs";
import type { WaitRun } from "../../chat/wait-runs";

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

function waitCall(id: number, status: ToolStatus = "done"): ToolItem {
	return tool(id, "wait", status);
}

/** The map `buildWaitRuns` returns for calls it folded into one run. */
function waitRunOf(...calls: ToolItem[]): Map<number, WaitRun> {
	const folded: WaitRun = { items: calls };
	return new Map(calls.map((call) => [call.id, folded]));
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

	// Every item kind that is neither a tool nor an assistant breaks the run.
	// The user row additionally pins that a suffix AFTER the breaker is a fresh
	// suffix for the next run: assistant(3) is consumed by tool(4), NOT folded
	// into run[1].
	const breakerCases: Array<{ kind: string; items: ChatItem[]; expected: Run[] }> = [
		{
			kind: "user",
			items: [tool(1, "read"), user(2), assistant(3, [thinking("h")]), tool(4, "glob")],
			expected: [
				run(1, [tool(1, "read")]),
				run(4, [tool(4, "glob")], {
					thinking: [thinking("h")],
					consumedAssistantIds: [3],
					turnCount: 1,
				}),
			],
		},
		{
			kind: "bash",
			items: [tool(1, "read"), bash(2), tool(3, "glob")],
			expected: [run(1, [tool(1, "read")]), run(3, [tool(3, "glob")])],
		},
		{
			kind: "compaction",
			items: [tool(1, "read"), compaction(2), tool(3, "glob")],
			expected: [run(1, [tool(1, "read")]), run(3, [tool(3, "glob")])],
		},
		{
			kind: "notice",
			items: [tool(1, "read"), notice(2), tool(3, "glob")],
			expected: [run(1, [tool(1, "read")]), run(3, [tool(3, "glob")])],
		},
	];
	for (const breakerCase of breakerCases) {
		test(`a ${breakerCase.kind} item breaks the run`, () => {
			expect(groupToolRuns(breakerCase.items)).toEqual(breakerCase.expected);
		});
	}

	test("a breaker clears a stale assistant suffix so it is never consumed", () => {
		// assistant(1) precedes the user, so the breaker must drop it entirely
		const items = [assistant(1, [thinking("h")]), user(2), tool(3, "read")];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([run(3, [tool(3, "read")])]);
		expect(runs[0]!.thinking).toEqual([]);
		expect(runs[0]!.consumedAssistantIds).toEqual([]);
		expect(runs[0]!.turnCount).toBe(0);
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
	test("a wait run counts as one call: later calls are not members", () => {
		const [w1, w2, w3] = [waitCall(2), waitCall(3), waitCall(4)];
		const items = [tool(1, "read"), w1, w2, w3, tool(5, "glob")];
		const runs = groupToolRuns(items, waitRunOf(w1, w2, w3));
		expect(runs).toEqual([run(1, [tool(1, "read"), w1, tool(5, "glob")])]);
		expect(runs[0]!.requestCount).toBe(3);
	});

	test("assistant items that draw nothing between a wait run's calls are consumed, not splitting", () => {
		const [w1, w2] = [waitCall(3), waitCall(5)];
		const items = [
			assistant(1, [thinking("plan")], 100),
			tool(2, "read"),
			w1,
			assistant(4, [text("")], 50),
			w2,
			tool(6, "edit"),
		];
		const runs = groupToolRuns(items, waitRunOf(w1, w2));
		expect(runs).toEqual([
			run(2, [tool(2, "read"), w1, tool(6, "edit")], {
				thinking: [thinking("plan")],
				consumedAssistantIds: [1, 4],
				turnCount: 2,
				durationMs: 150,
			}),
		]);
	});

	test("an agentic turn (A T A T A T A(prose)) is one run; the final prose is not consumed", () => {
		const items = [
			assistant(1, [thinking("a")], 100),
			tool(2, "read"),
			assistant(3, [thinking("b")], 200),
			tool(4, "grep"),
			assistant(5, [], 300),
			tool(6, "glob"),
			assistant(7, [thinking("c"), text("done")], 400),
		];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([
			run(2, [tool(2, "read"), tool(4, "grep"), tool(6, "glob")], {
				thinking: [thinking("a"), thinking("b")],
				consumedAssistantIds: [1, 3, 5],
				turnCount: 3,
				durationMs: 600,
			}),
		]);
		expect(runs[0]!.requestCount).toBe(3);
	});

	test("prose-less assistants directly before the first call are consumed even without thinking", () => {
		const items = [
			assistant(1, [text("intro")], 10),
			assistant(2, [], 20),
			assistant(3, [text("   ")], 30),
			tool(4, "read"),
		];
		expect(groupToolRuns(items)).toEqual([
			run(4, [tool(4, "read")], {
				consumedAssistantIds: [2, 3],
				turnCount: 2,
				durationMs: 50,
			}),
		]);
	});

	test("an assistant with prose between calls splits the run", () => {
		const items = [
			assistant(1, [thinking("a")]),
			tool(2, "read"),
			assistant(3, [thinking("b"), text("found it")]),
			tool(4, "grep"),
			assistant(5, [thinking("c")]),
			tool(6, "glob"),
		];
		expect(groupToolRuns(items)).toEqual([
			run(2, [tool(2, "read")], {
				thinking: [thinking("a")],
				consumedAssistantIds: [1],
				turnCount: 1,
			}),
			run(4, [tool(4, "grep"), tool(6, "glob")], {
				thinking: [thinking("b"), thinking("c")],
				consumedAssistantIds: [3, 5],
				turnCount: 2,
			}),
		]);
	});

	test("a trailing prose-less assistant after the last call is not consumed", () => {
		const items = [
			assistant(1, [thinking("a")], 100),
			tool(2, "read"),
			assistant(3, [thinking("b")], 200),
			tool(4, "grep"),
			assistant(5, [thinking("streaming")], 300),
		];
		const runs = groupToolRuns(items);
		expect(runs).toEqual([
			run(2, [tool(2, "read"), tool(4, "grep")], {
				thinking: [thinking("a"), thinking("b")],
				consumedAssistantIds: [1, 3],
				turnCount: 2,
				durationMs: 300,
			}),
		]);
	});

	test("a trailing prose-less assistant followed by prose stays out of the run", () => {
		const items = [tool(1, "read"), assistant(2, [thinking("h")]), assistant(3, [text("done")])];
		expect(groupToolRuns(items)).toEqual([run(1, [tool(1, "read")])]);
	});

	test("an interrupted assistant ends the run; its thinking folds into the next run's suffix", () => {
		const interrupted = { ...assistant(2, [thinking("h")]), interrupted: true };
		const items = [tool(1, "read"), interrupted, tool(3, "grep")];
		expect(groupToolRuns(items)).toEqual([
			run(1, [tool(1, "read")]),
			run(3, [tool(3, "grep")], {
				thinking: [thinking("h")],
				consumedAssistantIds: [2],
				turnCount: 1,
			}),
		]);
	});

	test("a wait run is running while any of its calls is, even when the first settled", () => {
		const [w1, w2] = [waitCall(1, "done"), waitCall(2, "running")];
		const runs = groupToolRuns([w1, w2], waitRunOf(w1, w2));
		expect(runs).toHaveLength(1);
		expect(runs[0]!.tools).toEqual([w1]);
		expect(runs[0]!.running).toBe(true);
	});

	test("without wait runs every wait call is its own member", () => {
		const items = [waitCall(1), waitCall(2)];
		expect(groupToolRuns(items)[0]!.requestCount).toBe(2);
	});
});

describe("indexToolRuns", () => {
	const items: ChatItem[] = [
		assistant(1, [thinking("h")]),
		tool(2, "read"),
		tool(3, "glob"),
		user(4),
		tool(5, "edit"),
	];
	const waitRuns = new Map<number, WaitRun>();

	test("maps every call to its run and lists the assistants whose thinking was folded", () => {
		const index = indexToolRuns(items, { consolidated: true, hideToolActivity: false, waitRuns });
		expect(index.runOf.get(2)).toBe(index.runOf.get(3));
		expect(index.runOf.get(5)).not.toBe(index.runOf.get(2));
		expect(index.runOf.get(5)!.key).toBe(5);
		expect([...index.consumedAssistantIds]).toEqual([1]);
	});

	test("hideToolActivity means no grouping, so thinking stays on its own card", () => {
		const index = indexToolRuns(items, { consolidated: true, hideToolActivity: true, waitRuns });
		expect(index.runOf.size).toBe(0);
		expect(index.consumedAssistantIds.size).toBe(0);
	});

	test("other modes do not group", () => {
		const index = indexToolRuns(items, { consolidated: false, hideToolActivity: false, waitRuns });
		expect(index.runOf.size).toBe(0);
		expect(index.consumedAssistantIds.size).toBe(0);
	});
});
