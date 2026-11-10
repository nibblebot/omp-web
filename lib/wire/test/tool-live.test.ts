/**
 * The live part of an eval or wait call's `details`: scalar-only, bounded status
 * events and watched jobs without their widgets and results. The session cuts it
 * for each running update and the web reads settled details through the same cut.
 */
import { describe, expect, test } from "bun:test";
import {
	EVAL_LIVE_EVENTS,
	LIVE_TEXT_CHARS,
	sameAsyncFrame,
	sameReplies,
	sameToolLive,
	slimAsyncFrame,
	slimEvalStatus,
	slimWaitJobs,
	toolLiveOf,
	toolReplies,
} from "../tool-live";

describe("slimEvalStatus", () => {
	test("keeps scalar fields and drops previews, thinking levels and structures", () => {
		const live = slimEvalStatus({
			statusEvents: [
				{
					op: "read",
					path: "a.ts",
					chars: 12,
					clean: true,
					preview: "file text",
					resolvedThinkingLevel: "high",
					nested: { a: 1 },
					list: [1],
					nothing: null,
				},
			],
		});
		expect(live).toEqual({
			kind: "eval",
			status: [{ op: "read", path: "a.ts", chars: 12, clean: true }],
		});
	});

	test("keeps the newest events and counts every older one, including the SDK's dropped ones", () => {
		const statusEvents = Array.from({ length: 12 }, (_, i) => ({ op: "log", message: `m${i}` }));
		const live = slimEvalStatus({ statusEvents, statusEventsElided: 5 });
		expect(live?.status.map((event) => event.message)).toEqual(
			statusEvents.slice(-EVAL_LIVE_EVENTS).map((event) => event.message),
		);
		expect(live?.elided).toBe(5 + 12 - EVAL_LIVE_EVENTS);
		// A settled card reads its whole bounded log.
		expect(slimEvalStatus({ statusEvents }, 200)?.status).toHaveLength(12);
	});

	test("skips malformed events as elided and clips long strings", () => {
		const live = slimEvalStatus({
			statusEvents: [null, { op: "" }, { op: "log", message: "x".repeat(LIVE_TEXT_CHARS + 50) }],
		});
		expect(live?.elided).toBe(2);
		const message = live?.status[0]?.message;
		expect(typeof message === "string" && message.length).toBe(LIVE_TEXT_CHARS);
	});

	test("is undefined when nothing was logged", () => {
		expect(slimEvalStatus({ cells: [] })).toBeUndefined();
		expect(slimEvalStatus({ statusEvents: [] })).toBeUndefined();
		expect(slimEvalStatus(undefined)).toBeUndefined();
	});
});

describe("slimWaitJobs", () => {
	const job = {
		id: "Trace",
		type: "task",
		status: "running",
		label: "Trace the retry path",
		durationMs: 4_000,
		stage: "  reading the outbox  ",
		completionPercent: 40,
		widget: { title: "big" },
		resultText: "long",
		structured: { data: 1 },
	};

	test("keeps the tile fields and drops widgets, results and model info", () => {
		expect(slimWaitJobs({ jobs: [job] })).toEqual({
			kind: "wait",
			jobs: [
				{
					id: "Trace",
					type: "task",
					status: "running",
					label: "Trace the retry path",
					durationMs: 4_000,
					stage: "reading the outbox",
					completionPercent: 40,
				},
			],
		});
	});

	test("a settled job keeps no completion estimate; unknown jobs and statuses are skipped", () => {
		const live = slimWaitJobs({
			jobs: [
				{ ...job, status: "failed", exitCode: 2 },
				{ ...job, id: "weird", type: "service" },
				{ ...job, id: "odd", status: "paused" },
				"junk",
			],
		});
		expect(live?.jobs).toEqual([
			{
				id: "Trace",
				type: "task",
				status: "failed",
				label: "Trace the retry path",
				durationMs: 4_000,
				exitCode: 2,
				stage: "reading the outbox",
			},
		]);
	});

	test("keeps the intent trimmed and bounded; a blank or non-string intent is dropped", () => {
		const intentOf = (intent: unknown) => slimWaitJobs({ jobs: [{ ...job, intent }] })?.jobs[0];
		expect(intentOf("  Watch the build  ")?.intent).toBe("Watch the build");
		const long = intentOf("x".repeat(LIVE_TEXT_CHARS + 50))?.intent;
		expect(long?.length).toBe(LIVE_TEXT_CHARS);
		expect(intentOf("   ")).not.toHaveProperty("intent");
		expect(intentOf(7)).not.toHaveProperty("intent");
		expect(slimWaitJobs({ jobs: [job] })?.jobs[0]).not.toHaveProperty("intent");
	});

	test("keeps a settled job's settle time (SDK 18.18.6); a non-finite or non-number one is dropped", () => {
		const settledOf = (settledAtMs: unknown) =>
			slimWaitJobs({ jobs: [{ ...job, status: "completed", settledAtMs }] })?.jobs[0];
		expect(settledOf(1_780_000_000_000)?.settledAtMs).toBe(1_780_000_000_000);
		expect(settledOf(Number.NaN)).not.toHaveProperty("settledAtMs");
		expect(settledOf(Number.POSITIVE_INFINITY)).not.toHaveProperty("settledAtMs");
		expect(settledOf("1780000000000")).not.toHaveProperty("settledAtMs");
		expect(slimWaitJobs({ jobs: [job] })?.jobs[0]).not.toHaveProperty("settledAtMs");
	});

	test("is undefined without a usable job", () => {
		expect(slimWaitJobs({ jobs: [] })).toBeUndefined();
		expect(slimWaitJobs({ op: "wait" })).toBeUndefined();
	});
});

describe("toolLiveOf and sameToolLive", () => {
	test("only eval and wait have a live status", () => {
		expect(toolLiveOf("bash", { statusEvents: [{ op: "log" }] })).toBeUndefined();
		expect(toolLiveOf("eval", { statusEvents: [{ op: "log" }] })?.kind).toBe("eval");
	});

	test("a wait's clock alone is not a change; a stage is", () => {
		const at = (durationMs: number, stage: string) =>
			slimWaitJobs({
				jobs: [{ id: "a", type: "task", status: "running", label: "l", durationMs, stage }],
			});
		expect(sameToolLive(at(1_000, "x"), at(2_500, "x"))).toBe(true);
		expect(sameToolLive(at(1_000, "x"), at(1_000, "y"))).toBe(false);
		expect(sameToolLive(undefined, at(0, "x"))).toBe(false);
		const intent = (text: string) =>
			slimWaitJobs({
				jobs: [{ id: "a", type: "bash", status: "running", label: "l", intent: text }],
			});
		expect(sameToolLive(intent("a"), intent("b"))).toBe(false);
		expect(sameToolLive(undefined, undefined)).toBe(true);
	});
});

describe("slimAsyncFrame", () => {
	test("keeps the job state and a failed command's exit code, nothing else of the details", () => {
		expect(
			slimAsyncFrame({
				async: { state: "failed", jobId: "bg_1", type: "bash" },
				exitCode: 2,
				meta: {},
			}),
		).toEqual({ state: "failed", exitCode: 2 });
		expect(slimAsyncFrame({ async: { state: "running", jobId: "bg_1" } })).toEqual({
			state: "running",
		});
	});

	test("is undefined for details that are not a job frame", () => {
		expect(slimAsyncFrame(undefined)).toBeUndefined();
		expect(slimAsyncFrame({})).toBeUndefined();
		expect(slimAsyncFrame({ async: { state: "paused" } })).toBeUndefined();
		expect(slimAsyncFrame({ async: "running" })).toBeUndefined();
	});

	test("two frames are the same when state and exit code match", () => {
		expect(sameAsyncFrame({ state: "running" }, { state: "running" })).toBe(true);
		expect(sameAsyncFrame({ state: "failed", exitCode: 1 }, { state: "failed", exitCode: 2 })).toBe(
			false,
		);
		expect(sameAsyncFrame(undefined, { state: "running" })).toBe(false);
		expect(sameAsyncFrame(undefined, undefined)).toBe(true);
	});
});

describe("toolReplies and sameReplies", () => {
	test("lists the text a call wrote to out://, oldest first", () => {
		expect(toolReplies({ replies: ["first", "second"] })).toEqual(["first", "second"]);
	});

	test("skips blank and non-string entries", () => {
		expect(toolReplies({ replies: ["", "  ", 3, null, "kept"] })).toEqual(["kept"]);
	});

	test("is undefined when the call wrote nothing", () => {
		expect(toolReplies(undefined)).toBeUndefined();
		expect(toolReplies({})).toBeUndefined();
		expect(toolReplies({ replies: [] })).toBeUndefined();
		expect(toolReplies({ replies: "one" })).toBeUndefined();
		expect(toolReplies({ replies: ["  "] })).toBeUndefined();
	});

	test("two lists are the same when every reply matches in order", () => {
		expect(sameReplies(["a", "b"], ["a", "b"])).toBe(true);
		expect(sameReplies(["a"], ["a", "b"])).toBe(false);
		expect(sameReplies(["a", "b"], ["b", "a"])).toBe(false);
		expect(sameReplies(undefined, ["a"])).toBe(false);
		expect(sameReplies(undefined, undefined)).toBe(true);
	});
});
