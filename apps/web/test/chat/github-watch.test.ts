import { describe, expect, test } from "bun:test";
import type { WireGithubWatch } from "#lib/wire/protocol";
import {
	formatWatchDuration,
	githubWatchOf,
	isRunWatchCall,
	jobProgress,
	safeHttpUrl,
	watchState,
	watchSummaryState,
} from "../../chat/github-watch";
import type { ToolItem } from "../../state";

const tool = (extra: Partial<ToolItem>): ToolItem => ({
	kind: "tool",
	id: 1,
	toolCallId: "c1",
	name: "github",
	args: { op: "run_watch" },
	status: "running",
	output: "",
	...extra,
});

describe("watchState", () => {
	test("a conclusion wins over the status; unrecognised states stay unknown", () => {
		expect(watchState({ status: "completed", conclusion: "success" })).toBe("success");
		expect(watchState({ status: "completed", conclusion: "neutral" })).toBe("success");
		expect(watchState({ status: "completed", conclusion: "skipped" })).toBe("skipped");
		expect(watchState({ status: "completed", conclusion: "cancelled" })).toBe("cancelled");
		for (const conclusion of ["failure", "timed_out", "action_required", "startup_failure"])
			expect(watchState({ status: "completed", conclusion })).toBe("failure");
		expect(watchState({ status: "completed", conclusion: "stale" })).toBe("unknown");
		expect(watchState({ status: "in_progress" })).toBe("running");
		for (const status of ["queued", "requested", "waiting", "pending"])
			expect(watchState({ status })).toBe("queued");
		expect(watchState({ status: "completed" })).toBe("unknown");
		expect(watchState({})).toBe("unknown");
	});
});

describe("jobProgress", () => {
	test("counts settled steps and finds the running and the first failed one", () => {
		const progress = jobProgress({
			id: 1,
			name: "test",
			steps: [
				{ number: 1, name: "a", status: "completed", conclusion: "success" },
				{ number: 2, name: "b", status: "completed", conclusion: "failure" },
				{ number: 3, name: "c", status: "completed" },
				{ number: 4, name: "d", status: "in_progress" },
			],
		});
		expect(progress).toMatchObject({
			total: 4,
			done: 3,
			failed: { number: 2 },
			running: { number: 4 },
		});
	});

	test("a job with no steps, or an empty list, has no progress", () => {
		expect(jobProgress({ id: 1, name: "x" })).toBeUndefined();
		expect(jobProgress({ id: 1, name: "x", steps: [] })).toBeUndefined();
	});
});

describe("watchSummaryState", () => {
	const watch = (...runs: { status?: string; conclusion?: string }[]): WireGithubWatch => ({
		mode: "commit",
		state: "watching",
		repo: "o/r",
		runs: runs.map((entry, index) => ({ id: index + 1, ...entry, jobs: [] })),
	});
	test("failure beats running beats queued; all green is success; no run yet is queued", () => {
		expect(watchSummaryState(watch())).toBe("queued");
		expect(
			watchSummaryState(
				watch({ status: "in_progress" }, { status: "completed", conclusion: "failure" }),
			),
		).toBe("failure");
		expect(
			watchSummaryState(
				watch({ status: "completed", conclusion: "success" }, { status: "in_progress" }),
			),
		).toBe("running");
		expect(
			watchSummaryState(
				watch(
					{ status: "completed", conclusion: "success" },
					{ status: "completed", conclusion: "success" },
				),
			),
		).toBe("success");
	});
});

describe("githubWatchOf", () => {
	const live: WireGithubWatch = {
		mode: "run",
		state: "watching",
		repo: "o/r",
		run: { id: 1, jobs: [] },
	};
	test("a settled call reads its details, an aborted one keeps the last live snapshot, another op has none", () => {
		const settled = {
			watch: { mode: "run", state: "completed", repo: "o/r", run: { id: 2, jobs: [] } },
		};
		expect(githubWatchOf(tool({ watch: live }))?.run?.id).toBe(1);
		expect(githubWatchOf(tool({ status: "done", watch: live, details: settled }))?.run?.id).toBe(2);
		expect(githubWatchOf(tool({ status: "interrupted", watch: live, details: {} }))?.run?.id).toBe(
			1,
		);
		expect(
			githubWatchOf(tool({ status: "done", args: { op: "repo_view" }, details: { repo: "o/r" } })),
		).toBeUndefined();
	});
});

describe("small helpers", () => {
	test("durations, call detection and links", () => {
		expect(formatWatchDuration(undefined)).toBeUndefined();
		expect(formatWatchDuration(0)).toBe("0s");
		expect(formatWatchDuration(42)).toBe("42s");
		expect(formatWatchDuration(125)).toBe("2m05s");
		expect(isRunWatchCall({ op: "run_watch" })).toBe(true);
		expect(isRunWatchCall({ op: "repo_view" })).toBe(false);
		expect(isRunWatchCall(null)).toBe(false);
		expect(safeHttpUrl("https://github.com/o/r/actions/runs/1")).toBe(
			"https://github.com/o/r/actions/runs/1",
		);
		expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
		expect(safeHttpUrl(undefined)).toBeUndefined();
	});
});
