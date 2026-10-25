/**
 * Folding consecutive wait calls into one card (`buildWaitRuns`) and merging a
 * run's calls (`mergeWaitRun`), plus the per-call parsing they build on
 * (`waitCallOf`, `jobTitle`, widgets).
 */
import { describe, expect, test } from "bun:test";
import type { WireWaitJob } from "#lib/wire/protocol";
import type { ChatItem, ToolItem } from "../../state";
import { jobTitle, waitCallOf, waitCounts } from "../../chat/wait-details";
import {
	assistantShowsContent,
	buildWaitRuns,
	jobElapsedMs,
	mergeWaitRun,
	waitMarksText,
	waitSummary,
	type WaitFoldOptions,
} from "../../chat/wait-runs";

const SHOWN: WaitFoldOptions = {
	hideThinking: false,
	proseOnlyThinking: true,
	showTokenUsage: false,
	turnMeta: new Map(),
};

const USAGE = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

let nextId = 1;

function tool(name: string, over: Partial<ToolItem> = {}): ToolItem {
	const id = nextId++;
	return {
		kind: "tool",
		id,
		toolCallId: `c${id}`,
		name,
		args: {},
		status: "done",
		output: "",
		...over,
	};
}

const job = (
	id: string,
	status: WireWaitJob["status"],
	over: Partial<WireWaitJob> = {},
): WireWaitJob => ({
	id,
	type: "bash",
	status,
	label: `run ${id}`,
	durationMs: 1_000,
	...over,
});

/** A settled wait over `jobs`, as the SDK's details carry them. */
const wait = (jobs: unknown[], details: Record<string, unknown> = {}): ToolItem =>
	tool("wait", { details: { op: "wait", jobs, ...details } });

const user = (): ChatItem => ({ kind: "user", id: nextId++, text: "go" });
const assistant = (blocks: { kind: "text" | "thinking"; text: string }[] = []): ChatItem => ({
	kind: "assistant",
	id: nextId++,
	blocks,
});

/** Groups of tool ids the fold produced, in transcript order. */
function groups(items: readonly ChatItem[], options = SHOWN): number[][] {
	const runs = buildWaitRuns(items, options);
	const seen = new Set<unknown>();
	const out: number[][] = [];
	for (const item of items) {
		const run = runs.get(item.id);
		if (!run || seen.has(run)) continue;
		seen.add(run);
		out.push(run.items.map((call) => call.id));
	}
	return out;
}

describe("run boundaries", () => {
	test("consecutive waits fold into one run keyed by every member", () => {
		const [a, b, c] = [wait([]), wait([]), wait([])];
		const runs = buildWaitRuns([a, b, c], SHOWN);
		expect(runs.get(a.id)).toBe(runs.get(b.id)!);
		expect(runs.get(b.id)).toBe(runs.get(c.id)!);
		expect(runs.get(a.id)?.items.map((call) => call.id)).toEqual([a.id, b.id, c.id]);
	});

	test("an assistant item that draws nothing does not end a run", () => {
		const [a, b, c] = [wait([]), wait([]), wait([])];
		const items = [
			a,
			assistant(),
			b,
			assistant([{ kind: "text", text: "  \n" }]),
			// Thinking that formats to nothing (a bare placeholder) draws nothing either.
			assistant([{ kind: "thinking", text: "..." }]),
			c,
		];
		expect(groups(items)).toEqual([[a.id, b.id, c.id]]);
	});

	test("visible assistant text ends the run", () => {
		const [a, b] = [wait([]), wait([])];
		expect(groups([a, assistant([{ kind: "text", text: "Still waiting." }]), b])).toEqual([
			[a.id],
			[b.id],
		]);
	});

	test("thinking ends the run unless thinking is hidden", () => {
		const [a, b] = [wait([]), wait([])];
		const items = [a, assistant([{ kind: "thinking", text: "Let me check the build." }]), b];
		expect(groups(items)).toEqual([[a.id], [b.id]]);
		expect(groups(items, { ...SHOWN, hideThinking: true })).toEqual([[a.id, b.id]]);
	});

	test("an interrupted assistant item draws a footer, so it ends the run", () => {
		const [a, b] = [wait([]), wait([])];
		const stopped: ChatItem = { kind: "assistant", id: nextId++, blocks: [], interrupted: true };
		expect(groups([a, stopped, b])).toEqual([[a.id], [b.id]]);
	});

	test("a user item ends the run", () => {
		const [a, b] = [wait([]), wait([])];
		expect(groups([a, user(), b])).toEqual([[a.id], [b.id]]);
	});

	test("any other tool item ends the run, even one that starts a job", () => {
		const [a, b] = [wait([]), wait([])];
		const bash = tool("bash", {
			details: { async: { state: "running", jobId: "bg_1", type: "bash" } },
		});
		expect(groups([a, assistant(), bash, b])).toEqual([[a.id], [b.id]]);
	});

	test("a notice or compaction ends the run", () => {
		const [a, b, c] = [wait([]), wait([]), wait([])];
		const notice: ChatItem = { kind: "notice", id: nextId++, level: "info", message: "x" };
		const compaction: ChatItem = {
			kind: "compaction",
			id: nextId++,
			action: "compact",
			skipped: false,
			aborted: false,
			willRetry: false,
		};
		expect(groups([a, notice, b, compaction, c])).toEqual([[a.id], [b.id], [c.id]]);
	});

	test("a wait that returned a peer message is its own card and ends the run around it", () => {
		const [a, message, c, d] = [
			wait([job("x", "running")]),
			wait([], { waited: { from: "Peer", ts: 1, body: "hi" } }),
			wait([job("x", "running")]),
			wait([job("x", "completed")]),
		];
		expect(groups([a, assistant(), message, assistant(), c, d])).toEqual([
			[a.id],
			[message.id],
			[c.id, d.id],
		]);
	});

	test("a failed or stopped wait stays its own card", () => {
		const [a, failed, c] = [wait([]), tool("wait", { status: "error", output: "boom" }), wait([])];
		const stopped = tool("wait", { status: "interrupted" });
		expect(groups([a, failed, c, stopped])).toEqual([[a.id], [failed.id], [c.id], [stopped.id]]);
	});

	test("interrupted and empty waits fold in as marks", () => {
		const [a, interrupted, empty, d] = [
			wait([job("x", "running")]),
			wait([job("x", "running")], { interrupted: true }),
			wait([]),
			wait([job("x", "completed")]),
		];
		expect(groups([a, interrupted, empty, d])).toEqual([[a.id, interrupted.id, empty.id, d.id]]);
	});

	test("a stream (running last wait with a live frame) and its history reload fold alike", () => {
		const lead = [user(), wait([job("x", "running")]), assistant()];
		const streaming = tool("wait", {
			status: "running",
			live: { kind: "wait", jobs: [job("x", "running")], at: 5 },
		});
		// History: the same last call, settled with its details and no live frame.
		const settled = { ...streaming, status: "done" as const };
		delete settled.live;
		settled.details = { op: "wait", jobs: [job("x", "completed")] };
		expect(groups([...lead, streaming])).toEqual(groups([...lead, settled]));
		expect(groups([...lead, settled])).toEqual([[lead[1]!.id, streaming.id]]);
	});

	test("assistantShowsContent reads text, displayable thinking and the interrupted footer", () => {
		const plain = (blocks: { kind: "text" | "thinking"; text: string }[]) =>
			assistant(blocks) as Extract<ChatItem, { kind: "assistant" }>;
		expect(assistantShowsContent(plain([]), SHOWN)).toBe(false);
		expect(assistantShowsContent(plain([{ kind: "text", text: "hi" }]), SHOWN)).toBe(true);
		const thought = plain([{ kind: "thinking", text: "Considering the retry path." }]);
		expect(assistantShowsContent(thought, SHOWN)).toBe(true);
		expect(assistantShowsContent(thought, { ...SHOWN, hideThinking: true })).toBe(false);
	});

	test("a turn that draws a usage row ends the run only while token usage is shown", () => {
		const [a, b] = [wait([job("x", "running")]), wait([job("x", "completed")])];
		const metered = { ...assistant(), usage: USAGE } as ChatItem;
		expect(groups([a, metered, b])).toEqual([[a.id, b.id]]);
		expect(groups([a, metered, b], { ...SHOWN, showTokenUsage: true })).toEqual([[a.id], [b.id]]);
	});

	test("a turn that draws a cache-miss marker ends the run", () => {
		const [a, b] = [wait([job("x", "running")]), wait([job("x", "completed")])];
		const cold = assistant();
		const turnMeta = new Map([[cold.id, { cacheMissTokens: 4000 }]]);
		expect(groups([a, cold, b])).toEqual([[a.id, b.id]]);
		expect(groups([a, cold, b], { ...SHOWN, turnMeta })).toEqual([[a.id], [b.id]]);
	});
});

describe("merging a run", () => {
	test("each job takes its latest status and earlier-settled jobs stay listed", () => {
		const run = [
			wait([job("build", "completed"), job("test", "running"), job("lint", "running")]),
			wait([job("test", "running", { durationMs: 5_000 }), job("lint", "running")]),
			wait([job("test", "failed", { exitCode: 1 }), job("lint", "completed")]),
		];
		const view = mergeWaitRun(run);
		expect(view.waits).toBe(3);
		const byId = new Map(view.jobs.map((entry) => [entry.job.id, entry]));
		expect([...byId.keys()].sort()).toEqual(["build", "lint", "test"]);
		expect(byId.get("build")?.job.status).toBe("completed");
		expect(byId.get("test")?.job).toMatchObject({ status: "failed", exitCode: 1 });
		expect(byId.get("lint")?.job.status).toBe("completed");
	});

	test("a job records the wait it settled in, not later waits that list it again", () => {
		const view = mergeWaitRun([
			wait([job("a", "running"), job("b", "running")]),
			wait([job("a", "completed"), job("b", "running")]),
			wait([job("a", "completed"), job("b", "failed")]),
		]);
		const settled = Object.fromEntries(view.jobs.map((entry) => [entry.job.id, entry.settledAt]));
		expect(settled).toEqual({ a: 1, b: 2 });
	});

	test("sorts running, failed, cancelled, then completed with the most recently settled first", () => {
		const view = mergeWaitRun([
			wait([job("early", "completed"), job("slow", "running", { durationMs: 9_000 })]),
			wait([job("quick", "running", { durationMs: 1_000 })]),
			wait([job("late", "completed"), job("gone", "cancelled"), job("bad", "failed")]),
		]);
		expect(view.jobs.map((entry) => entry.job.id)).toEqual([
			"slow",
			"quick",
			"bad",
			"gone",
			"late",
			"early",
		]);
	});

	test("a running last wait overrides from its live frame and its clock advances from arrival", () => {
		const settled = wait([
			job("build", "completed"),
			job("test", "running", { durationMs: 2_000 }),
		]);
		const running = tool("wait", {
			status: "running",
			live: {
				kind: "wait",
				jobs: [job("test", "running", { durationMs: 4_000 }), job("lint", "running")],
				at: 1_000,
			},
		});
		const view = mergeWaitRun([settled, running]);
		const byId = new Map(view.jobs.map((entry) => [entry.job.id, entry]));
		expect(byId.get("build")?.job.status).toBe("completed");
		const test = byId.get("test")!;
		expect(test.job.durationMs).toBe(4_000);
		expect(test.at).toBe(1_000);
		expect(jobElapsedMs(test, 3_500)).toBe(4_000 + 2_500);
		// Only a job of the live frame counts up; a settled one keeps its run time.
		expect(byId.get("build")?.at).toBeUndefined();
		expect(jobElapsedMs(byId.get("build")!, 3_500)).toBe(1_000);
		expect(waitSummary(view)).toBe("waiting on 2 of 3 jobs");
	});

	test("a running wait before its first frame lists nothing and is no mark", () => {
		const view = mergeWaitRun([tool("wait", { status: "running" })]);
		expect(view).toMatchObject({ jobs: [], agents: [], waits: 1, interruptions: 0, empties: 0 });
	});

	test("agents are the latest wait's alone", () => {
		const agent = (id: string) => ({ id, ageMs: 5, live: true });
		const view = mergeWaitRun([
			wait([], { agents: [agent("First")] }),
			wait([], { agents: [agent("Second")] }),
		]);
		expect(view.agents.map((entry) => entry.id)).toEqual(["Second"]);
		expect(waitSummary(view)).toBe("1 running agent, no jobs");
	});

	test("interrupted and empty waits count as marks and their jobs still merge", () => {
		const view = mergeWaitRun([
			wait([job("a", "running")], { interrupted: true }),
			wait([]),
			wait([]),
			wait([job("a", "completed")]),
		]);
		expect(view).toMatchObject({ waits: 4, interruptions: 1, empties: 2 });
		expect(view.jobs.map((entry) => entry.job.status)).toEqual(["completed"]);
		expect(waitMarksText(view)).toBe("interrupted by a message \u00b7 nothing to wait for 2 times");
		expect(waitMarksText({ interruptions: 0, empties: 0 })).toBeUndefined();
		expect(waitMarksText({ interruptions: 2, empties: 1 })).toBe(
			"interrupted by a message 2 times \u00b7 nothing to wait for",
		);
	});

	test("the widget of the latest settled wait that kept one rides with its job", () => {
		const widget = {
			title: "bench \u001b[1mrun\u001b[0m",
			state: "live",
			updatedAt: 5,
			blocks: [{ kind: "meter", label: "trials", value: 3, text: "7/9", tone: "bogus" }],
		};
		const view = mergeWaitRun([
			wait([
				{ ...job("bench", "running"), widget },
				{ ...job("bad", "running"), widget: "nope" },
			]),
			wait([job("bench", "completed"), job("bad", "completed")]),
		]);
		const byId = new Map(view.jobs.map((entry) => [entry.job.id, entry]));
		expect(byId.get("bench")?.widget).toEqual({
			title: "bench run",
			blocks: [{ kind: "meter", label: "trials", value: 1, text: "7/9" }],
			state: "live",
			updatedAt: 5,
		});
		expect(byId.get("bad")?.widget).toBeUndefined();
	});
});

describe("one call", () => {
	const jobs = [
		{ id: "bg_done", type: "bash", status: "completed", label: "build", durationMs: 9_000 },
		{ id: "Trace", type: "task", status: "running", label: "Trace it", durationMs: 4_000 },
		{
			id: "bg_fail",
			type: "bash",
			status: "failed",
			label: "test\nsecond line",
			durationMs: 2_000,
			exitCode: 1,
		},
	];

	test("a subagent goes by its id, any other job by the first line of its label", () => {
		const call = waitCallOf(wait(jobs));
		const byId = (id: string) => call.jobs.find((entry) => entry.id === id)!;
		expect(jobTitle(byId("bg_done"))).toBe("build");
		expect(jobTitle(byId("Trace"))).toBe("Trace");
		expect(jobTitle(byId("bg_fail"))).toBe("test");
	});

	test("a settled call reads details; a running call reads its live frame and carries no widgets", () => {
		const settled = waitCallOf(wait(jobs, { interrupted: true }));
		expect(settled).toMatchObject({ live: false, interrupted: true, message: false });
		expect(settled.jobs).toHaveLength(3);
		const live = {
			kind: "wait" as const,
			jobs: [job("a", "running")],
			at: 1,
		};
		const running = waitCallOf(tool("wait", { status: "running", live, details: { jobs } }));
		expect(running).toMatchObject({ live: true, at: 1 });
		expect(running.jobs.map((entry) => entry.id)).toEqual(["a"]);
		expect(running.widgets.size).toBe(0);
		expect(waitCallOf(wait([], { waited: { from: "P" } })).message).toBe(true);
	});

	test("counts and summary say what is left", () => {
		const view = mergeWaitRun([wait(jobs)]);
		expect(waitCounts(view.jobs.map((entry) => entry.job))).toEqual({
			running: 1,
			completed: 1,
			failed: 1,
			cancelled: 0,
		});
		expect(waitSummary(view)).toBe("waiting on 1 of 3 jobs");
		expect(waitSummary(mergeWaitRun([wait([job("a", "completed")])]))).toBe("1 job settled");
	});
});
