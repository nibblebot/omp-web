import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	aggregateJobStates,
	applyAsyncResults,
	asyncJobOf,
	asyncResultJobsOf,
	backgroundOf,
	effectiveStatus,
	originJobIds,
	reconcileBackgroundJobs,
	settleBackground,
	type ListedJob,
} from "../../chat/background-job";
import { createHistoryBuilder } from "../../chat/history-items";
import type { ChatItem, ToolItem } from "../../state";

const running = (jobId: string, type = "bash", extra: Record<string, unknown> = {}) => ({
	async: { state: "running", jobId, type },
	...extra,
});

function card(name: string, details: unknown, over: Partial<ToolItem> = {}): ToolItem {
	const item: ToolItem = {
		kind: "tool",
		id: 1,
		toolCallId: `call_${name}`,
		name,
		args: {},
		status: "done",
		output: "Backgrounded",
		details,
		...over,
	};
	const parked = backgroundOf(name, details, 1000);
	if (parked !== undefined) item.background = parked;
	return item;
}

const msg = (value: Record<string, unknown>) => value as unknown as AgentMessage;

function delivery(...jobs: Array<Record<string, unknown>>): AgentMessage {
	return msg({ role: "custom", customType: "async-result", display: true, details: { jobs } });
}

describe("asyncJobOf", () => {
	test("reads a well-formed job frame and nothing else", () => {
		expect(asyncJobOf(running("bg_1"))).toEqual({ state: "running", jobId: "bg_1", type: "bash" });
		expect(asyncJobOf({ async: { state: "cancelled", jobId: "x", type: "eval" } })?.state).toBe(
			"cancelled",
		);
		expect(asyncJobOf({ async: { state: "paused", jobId: "x" } })).toBeUndefined();
		expect(asyncJobOf({ async: { state: "running" } })).toBeUndefined();
		expect(asyncJobOf({ async: { state: "running", jobId: "" } })).toBeUndefined();
		expect(asyncJobOf(null)).toBeUndefined();
		expect(asyncJobOf("details")).toBeUndefined();
	});
});

describe("backgroundOf", () => {
	test("parks a bash, eval or task call whose job still runs", () => {
		expect(backgroundOf("bash", running("bg_1"), 5)).toMatchObject({
			jobId: "bg_1",
			type: "bash",
			state: "running",
			jobIds: ["bg_1"],
			startedAt: 5,
		});
		expect(backgroundOf("eval", running("bg_2", "eval"), 5)?.jobId).toBe("bg_2");
	});

	test("a task waits on every open subagent it spawned", () => {
		const parked = backgroundOf(
			"task",
			running("a", "task", {
				progress: [
					{ id: "a", status: "running" },
					{ id: "b", status: "pending" },
					{ id: "c", status: "completed" },
				],
			}),
			5,
		);
		expect(parked?.jobIds).toEqual(["a", "b"]);
	});

	test("a settled frame, another tool or a plain result is not parked", () => {
		expect(backgroundOf("bash", { async: { state: "completed", jobId: "x" } }, 5)).toBeUndefined();
		expect(backgroundOf("read", running("x"), 5)).toBeUndefined();
		expect(backgroundOf("bash", {}, 5)).toBeUndefined();
	});
});

describe("originJobIds", () => {
	test("names the job a call started, and the subagents a task lists", () => {
		const bash = card("bash", running("bg_1"));
		const task = card("task", running("a", "task", { progress: [{ id: "a" }, { id: "b" }] }), {
			id: 2,
		});
		expect(originJobIds(bash)).toEqual(["bg_1"]);
		expect(originJobIds(task)).toEqual(["a", "a", "b"]);
		expect(originJobIds(card("read", undefined))).toEqual([]);
	});
});

describe("settleBackground", () => {
	test("completed is done, failed is an error with its exit code, cancelled is interrupted", () => {
		const done = card("bash", running("bg_1"));
		expect(effectiveStatus(done)).toBe("running");
		expect(settleBackground(done, { state: "completed", durationMs: 50 })).toBe(true);
		expect(done.status).toBe("done");
		expect(done.background).toMatchObject({ state: "completed", durationMs: 50 });
		expect(effectiveStatus(done)).toBe("done");

		const failed = card("bash", running("bg_2"));
		settleBackground(failed, { state: "failed", exitCode: 3 });
		expect(failed.status).toBe("error");
		expect(failed.background?.exitCode).toBe(3);

		const cancelled = card("bash", running("bg_3"));
		settleBackground(cancelled, { state: "cancelled" });
		expect(cancelled.status).toBe("interrupted");
		expect(cancelled.output).toBe("Backgrounded");
	});

	test("a card that is not parked on a running job never changes", () => {
		const plain = card("bash", {});
		expect(settleBackground(plain, { state: "failed" })).toBe(false);
		expect(plain.status).toBe("done");
		const settled = card("bash", running("bg_1"));
		settleBackground(settled, { state: "completed" });
		expect(settleBackground(settled, { state: "failed" })).toBe(false);
		expect(settled.status).toBe("done");
	});
});

describe("aggregateJobStates", () => {
	test("failed beats cancelled beats completed; an unknown job leaves the call open", () => {
		expect(aggregateJobStates(["completed", "completed"])).toBe("completed");
		expect(aggregateJobStates(["completed", "cancelled"])).toBe("cancelled");
		expect(aggregateJobStates(["cancelled", "failed", "completed"])).toBe("failed");
		expect(aggregateJobStates(["completed", undefined])).toBeUndefined();
		expect(aggregateJobStates([])).toBeUndefined();
	});
});

describe("asyncResultJobsOf", () => {
	test("lists the settled jobs of an async-result message and nothing from any other message", () => {
		const jobs = asyncResultJobsOf(
			delivery(
				{ jobId: "a", status: "completed", durationMs: 1200, agentId: "Anna" },
				{ jobId: "b", status: "failed" },
				{ jobId: "c", status: "running" },
				{ status: "completed" },
			),
		);
		expect(jobs).toEqual([
			{ jobId: "a", state: "completed", durationMs: 1200, agentId: "Anna" },
			{ jobId: "b", state: "failed" },
		]);
		expect(asyncResultJobsOf(msg({ role: "custom", customType: "advisor", details: {} }))).toEqual(
			[],
		);
		expect(asyncResultJobsOf(msg({ role: "user", content: "hi" }))).toEqual([]);
	});
});

describe("applyAsyncResults", () => {
	test("settles the card of the job, matching a task by its subagent id", () => {
		const bash = card("bash", running("bg_1"));
		const task = card(
			"task",
			running("job-x", "task", { progress: [{ id: "Anna", status: "running" }] }),
			{
				id: 2,
			},
		);
		const changed = applyAsyncResults(
			[bash, task],
			[
				{ jobId: "bg_1", state: "failed", durationMs: 90 },
				{ jobId: "job-x", agentId: "Anna", state: "completed", durationMs: 300 },
			],
		);
		expect(changed).toHaveLength(2);
		expect(bash.status).toBe("error");
		expect(bash.background?.durationMs).toBe(90);
		expect(task.status).toBe("done");
		expect(task.background).toMatchObject({ state: "completed", durationMs: 300 });
	});

	test("a task with several spawns settles when its last job does", () => {
		const task = card(
			"task",
			running("a", "task", {
				progress: [
					{ id: "a", status: "running" },
					{ id: "b", status: "running" },
				],
			}),
		);
		applyAsyncResults([task], [{ jobId: "a", state: "completed" }]);
		expect(task.background?.state).toBe("running");
		expect(effectiveStatus(task)).toBe("running");
		applyAsyncResults([task], [{ jobId: "b", state: "failed" }]);
		expect(task.background?.state).toBe("failed");
		expect(task.status).toBe("error");
	});

	test("leaves other cards alone", () => {
		const other = card("bash", running("bg_other"));
		expect(applyAsyncResults([other], [{ jobId: "bg_1", state: "completed" }])).toEqual([]);
		expect(other.background?.state).toBe("running");
	});
});

describe("history reload", () => {
	const call = msg({
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 9" } }],
	});
	const startResult = msg({
		role: "toolResult",
		toolCallId: "c1",
		toolName: "bash",
		content: [{ type: "text", text: "Backgrounded as job bg_1" }],
		isError: false,
		details: running("bg_1"),
		timestamp: 7000,
	});

	function tools(items: readonly ChatItem[]): ToolItem[] {
		return items.filter((item): item is ToolItem => item.kind === "tool");
	}

	test("the start result parks the card on its job", () => {
		const [tool] = tools(createHistoryBuilder().append([call, startResult]).items);
		expect(tool).toMatchObject({
			status: "done",
			output: "Backgrounded as job bg_1",
			background: { jobId: "bg_1", state: "running", startedAt: 7000 },
		});
	});

	test("a later async-result settles the card: completed, failed and cancelled", () => {
		for (const [status, expected] of [
			["completed", "done"],
			["failed", "error"],
			["cancelled", "interrupted"],
		] as const) {
			const built = createHistoryBuilder().append([
				call,
				startResult,
				delivery({ jobId: "bg_1", status, durationMs: 4200 }),
			]);
			const [tool] = tools(built.items);
			expect(tool?.status).toBe(expected);
			expect(tool?.background).toMatchObject({ state: status, durationMs: 4200 });
			// The delivery has no output of the job: the card keeps its start text.
			expect(tool?.output).toBe("Backgrounded as job bg_1");
		}
	});

	test("a delivery in a later append patches the card handed out earlier", () => {
		const builder = createHistoryBuilder();
		const first = builder.append([call, startResult]);
		const second = builder.append([delivery({ jobId: "bg_1", status: "failed" })]);
		expect(second.items).toEqual([]);
		expect(second.patched).toEqual(tools(first.items));
		expect(tools(first.items)[0]?.status).toBe("error");
	});

	test("jobs a wait consumed settle their cards, though no async-result was delivered", () => {
		const waitCall = msg({
			role: "assistant",
			content: [{ type: "toolCall", id: "w1", name: "wait", arguments: {} }],
		});
		const waitResult = msg({
			role: "toolResult",
			toolCallId: "w1",
			toolName: "wait",
			content: [{ type: "text", text: "jobs settled" }],
			isError: false,
			details: {
				jobs: [
					{ id: "bg_1", type: "bash", status: "failed", label: "sleep", durationMs: 700 },
					{ id: "bg_2", type: "bash", status: "running", label: "other", durationMs: 5 },
				],
			},
		});
		const builder = createHistoryBuilder();
		const first = builder.append([call, startResult]);
		expect(tools(first.items)[0]?.background?.state).toBe("running");
		const second = builder.append([waitCall, waitResult]);
		expect(tools(first.items)[0]).toMatchObject({
			status: "error",
			background: { state: "failed", durationMs: 700 },
		});
		expect(second.patched).toEqual(tools(first.items));

		const same = createHistoryBuilder().append([call, startResult, waitCall, waitResult]);
		expect(tools(same.items)[0]?.background?.state).toBe("failed");
	});

	test("a delivery for another job leaves the card parked", () => {
		const built = createHistoryBuilder().append([
			call,
			startResult,
			delivery({ jobId: "bg_other", status: "completed" }),
		]);
		expect(tools(built.items)[0]?.background?.state).toBe("running");
	});
});

describe("reconcileBackgroundJobs", () => {
	const job = (over: Partial<ListedJob> & { id: string }): ListedJob => ({
		status: "running",
		startTime: 1000,
		...over,
	});

	test("a settled job in the list settles its card with the job's run time", () => {
		const bash = card("bash", running("bg_1"));
		reconcileBackgroundJobs([bash], [job({ id: "bg_1", status: "failed", endTime: 4000 })]);
		expect(bash.status).toBe("error");
		expect(bash.background).toMatchObject({ state: "failed", durationMs: 3000 });
	});

	test("a job that still runs keeps its card parked", () => {
		const bash = card("bash", running("bg_1"));
		expect(reconcileBackgroundJobs([bash], [job({ id: "bg_1" })])).toEqual([]);
		expect(bash.background?.state).toBe("running");
	});

	test("a job the list no longer has leaves a plain done card with its start text", () => {
		const bash = card("bash", running("bg_1"));
		reconcileBackgroundJobs([bash], [job({ id: "other", status: "completed" })]);
		expect(bash.background).toBeUndefined();
		expect(bash.status).toBe("done");
		expect(bash.output).toBe("Backgrounded");
		expect(effectiveStatus(bash)).toBe("done");
	});

	test("an unreadable list knows nothing either", () => {
		const bash = card("bash", running("bg_1"));
		reconcileBackgroundJobs([bash], undefined);
		expect(bash.background).toBeUndefined();
		expect(bash.status).toBe("done");
	});

	test("a task matches its subagent's job by agent id", () => {
		const task = card(
			"task",
			running("job-x", "task", { progress: [{ id: "Anna", status: "running" }] }),
		);
		task.background!.jobIds = ["Anna"];
		reconcileBackgroundJobs(
			[task],
			[job({ id: "job-x", agentId: "Anna", status: "completed", endTime: 2000 })],
		);
		expect(task.background?.state).toBe("completed");
	});
});
