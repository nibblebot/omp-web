/**
 * What eval and wait cards read from a call's settled `details` or live frame:
 * printed views placed in the output, status events and MCP progress text, and
 * the tiles of a wait.
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
import {
	jobElapsedMs,
	jobTitle,
	waitSummary,
	waitViewOf,
	WAIT_TILES_SHOWN,
} from "../../chat/wait-details";
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

describe("wait tiles", () => {
	const jobs = [
		{ id: "bg_done", type: "bash", status: "completed", label: "build", durationMs: 9_000 },
		{
			id: "Trace",
			type: "task",
			status: "running",
			label: "Trace it",
			durationMs: 4_000,
			stage: "reading",
		},
		{
			id: "bg_fail",
			type: "bash",
			status: "failed",
			label: "test\nsecond line",
			durationMs: 2_000,
			exitCode: 1,
		},
		{ id: "bg_run", type: "eval", status: "running", label: "fetch", durationMs: 8_000 },
	];

	test("a settled call's jobs sort running first (longest first), then failed, then done", () => {
		const view = waitViewOf(item("wait", { details: { op: "wait", jobs } }));
		expect(view?.jobs.map((job) => job.id)).toEqual(["bg_run", "Trace", "bg_fail", "bg_done"]);
		expect(view?.live).toBe(false);
		expect(waitSummary(view!)).toBe("waiting on 2 of 4 jobs");
	});

	test("a running call reads its live frame and advances running clocks from its arrival", () => {
		const live = {
			kind: "wait" as const,
			jobs: [{ ...jobs[1]!, type: "task" as const, status: "running" as const }],
			at: 1_000,
		};
		const view = waitViewOf(item("wait", { status: "running", live }));
		expect(view?.live).toBe(true);
		const job = view!.jobs[0]!;
		expect(jobElapsedMs(job, view!, 3_500)).toBe(4_000 + 2_500);
		expect(jobElapsedMs({ ...job, status: "completed" }, view!, 3_500)).toBe(4_000);
		// Before the first frame there is nothing to show.
		expect(waitViewOf(item("wait", { status: "running" }))).toBeUndefined();
	});

	test("agents without a job row count when no job is listed; an empty wait has no view", () => {
		const view = waitViewOf(
			item("wait", {
				details: { op: "wait", jobs: [], agents: [{ id: "Peer", ageMs: 5, live: false }] },
			}),
		);
		expect(view?.agents).toEqual([{ id: "Peer", ageMs: 5, live: false }]);
		expect(waitSummary(view!)).toBe("1 running agent, no jobs");
		expect(waitViewOf(item("wait", { details: { op: "wait", jobs: [] } }))).toBeUndefined();
		expect(WAIT_TILES_SHOWN).toBe(9);
	});

	test("a subagent goes by its id, any other job by the first line of its label", () => {
		const [done, task, fail] = jobs;
		const view = waitViewOf(item("wait", { details: { op: "wait", jobs } }));
		const byId = (id: string) => view!.jobs.find((job) => job.id === id)!;
		expect(jobTitle(byId(done!.id))).toBe("build");
		expect(jobTitle(byId(task!.id))).toBe("Trace");
		expect(jobTitle(byId(fail!.id))).toBe("test");
	});

	test("a settled call keeps each job's widget as a clean view; a running call carries none", () => {
		const widget = {
			title: "bench \u001b[1mrun\u001b[0m",
			state: "live",
			updatedAt: 5,
			blocks: [{ kind: "meter", label: "trials", value: 3, text: "7/9", tone: "bogus" }],
		};
		const withWidgets = [{ ...jobs[0]!, widget }, { ...jobs[1]!, widget: "nope" }, jobs[2]!];
		const view = waitViewOf(item("wait", { details: { op: "wait", jobs: withWidgets } }));
		expect([...view!.widgets.keys()]).toEqual(["bg_done"]);
		expect(view!.widgets.get("bg_done")).toEqual({
			title: "bench run",
			blocks: [{ kind: "meter", label: "trials", value: 1, text: "7/9" }],
			state: "live",
			updatedAt: 5,
		});
		const live = {
			kind: "wait" as const,
			jobs: [{ ...jobs[1]!, type: "task" as const, status: "running" as const }],
			at: 1,
		};
		expect(
			waitViewOf(item("wait", { status: "running", live, details: { jobs: withWidgets } }))?.widgets
				.size,
		).toBe(0);
	});
});
