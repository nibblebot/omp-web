/**
 * What eval cards read from a call's settled `details` or live frame: printed
 * views placed in the output, status events and MCP progress text. The wait
 * card's parsing is in wait-runs.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
	describeStatusEvent,
	evalNotes,
	evalStatusOf,
	evalViews,
	formatMcpProgress,
	splitEvalOutput,
} from "../../chat/eval-details";
import type { ToolItem } from "../../state";

function item(name: string, over: Partial<ToolItem>): ToolItem {
	return {
		kind: "tool",
		id: 1,
		toolCallId: "c1",
		name,
		args: {},
		status: "done",
		output: "",
		...over,
	};
}

describe("eval views", () => {
	const table = {
		kind: "table",
		columns: [{ head: "n", numeric: true }, { head: "name" }],
		rows: [["1", "a"]],
	};
	const details = {
		cells: [
			{ views: [{ text: "df\ttext", view: table }] },
			{ views: [{ text: "{'a': 1}", view: { kind: "json", value: { a: 1 } } }] },
		],
	};

	test("reads the views of every cell, normalizing columns and tab text", () => {
		const views = evalViews(details);
		expect(views.map((entry) => entry.text)).toEqual(["df  text", "{'a': 1}"]);
		expect(views[0]?.view).toEqual({
			kind: "table",
			columns: [
				{ head: "n", numeric: true },
				{ head: "name", numeric: false },
			],
			rows: [["1", "a"]],
		});
	});

	test("drops entries whose view does not parse", () => {
		expect(
			evalViews({
				cells: [
					{
						views: [
							{ text: "a", view: { kind: "table", columns: "x", rows: [] } },
							{ text: "b", view: { kind: "markdown" } },
							{ text: "", view: { kind: "json", value: 1 } },
							{ text: "c", view: { kind: "markdown", text: "# c" } },
						],
					},
				],
			}),
		).toEqual([{ text: "c", view: { kind: "markdown", text: "# c" } }]);
		expect(evalViews(undefined)).toEqual([]);
	});

	test("places each view where its text was printed and keeps the text around it", () => {
		const views = evalViews(details);
		const parts = splitEvalOutput("before\ndf  text\nmiddle\n{'a': 1}\nafter", views);
		expect(parts.map((part) => (part.kind === "text" ? part.text : part.view.kind))).toEqual([
			"before",
			"table",
			"middle",
			"json",
			"after",
		]);
	});

	test("skips a view whose text is no longer in the output (tail cap) and keeps the rest as text", () => {
		const views = evalViews(details);
		const parts = splitEvalOutput("only the tail {'a': 1}", views);
		expect(parts).toEqual([
			{ kind: "text", text: "only the tail " },
			{ kind: "view", view: { kind: "json", value: { a: 1 } } },
		]);
		expect(splitEvalOutput("plain", [])).toEqual([{ kind: "text", text: "plain" }]);
	});
});

describe("eval status", () => {
	test("MCP progress shows its tool and the message with the count; the id stays internal", () => {
		const line = describeStatusEvent({
			op: "mcp_progress",
			id: "c1",
			tool: "linear/list",
			progress: 3,
			total: 10,
			message: "Fetching\npage 3",
		});
		expect(line).toEqual({
			op: "mcp_progress",
			fields: [{ key: "tool", value: "linear/list" }],
			progress: "Fetching page 3 (3/10)",
		});
	});

	test("progress without a message is the bare count; without a total, only the message", () => {
		expect(formatMcpProgress({ op: "mcp_progress", progress: 4, total: 8 })).toBe("4/8");
		expect(formatMcpProgress({ op: "mcp_progress", progress: 4 })).toBe("4");
		expect(formatMcpProgress({ op: "mcp_progress", progress: 4, message: "Indexing" })).toBe(
			"Indexing",
		);
		expect(formatMcpProgress({ op: "mcp_progress", message: "x" })).toBeUndefined();
	});

	test("other events list their scalar fields in order", () => {
		expect(describeStatusEvent({ op: "read", path: "a.ts", chars: 12, ok: true }).fields).toEqual([
			{ key: "path", value: "a.ts" },
			{ key: "chars", value: "12" },
			{ key: "ok", value: "true" },
		]);
	});

	test("a running card reads the live frame, a settled card its bounded log", () => {
		const live = { kind: "eval" as const, status: [{ op: "log", message: "live" }], at: 1 };
		expect(evalStatusOf(item("eval", { status: "running", live }))).toEqual(live);
		expect(evalStatusOf(item("eval", { status: "running" }))).toBeUndefined();
		expect(
			evalStatusOf(
				item("eval", {
					details: { statusEvents: [{ op: "log", message: "done" }], statusEventsElided: 2 },
				}),
			),
		).toEqual({ kind: "eval", status: [{ op: "log", message: "done" }], elided: 2 });
		// The live frame of a call that has since settled never shows.
		expect(evalStatusOf(item("eval", { live }))).toBeUndefined();
	});

	test("notes: the fallback notice and a backgrounded job", () => {
		expect(evalNotes({ notice: "ran in js", async: { state: "running", jobId: "bg_1" } })).toEqual([
			"ran in js",
			"Backgrounded as job bg_1",
		]);
		expect(evalNotes({ async: { state: "completed", jobId: "bg_1" } })).toEqual([]);
	});
});
