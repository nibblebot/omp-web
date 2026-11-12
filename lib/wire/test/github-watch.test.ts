import { describe, expect, test } from "bun:test";
import {
	sameGithubWatch,
	slimGithubWatch,
	WATCH_TAIL_CHARS,
	WATCH_TEXT_CHARS,
} from "../github-watch";

const run = {
	id: 7,
	workflowName: "CI",
	status: "in_progress",
	jobs: [
		{
			id: 1,
			name: "test",
			status: "in_progress",
			durationSeconds: 63,
			steps: [
				{
					number: 1,
					name: "Set up job",
					status: "completed",
					conclusion: "success",
					durationSeconds: 1,
				},
				{ number: 2, name: "Run tests", status: "in_progress", durationSeconds: 41 },
				{ number: 3, name: "Upload coverage", status: "queued" },
			],
		},
	],
};
const details = (watch: Record<string, unknown> = {}) => ({
	repo: "o/r",
	watch: { mode: "run", state: "watching", repo: "o/r", pollCount: 3, run, ...watch },
});

describe("slimGithubWatch", () => {
	test("keeps the ordered steps with their state and duration, and drops the poll counter", () => {
		const watch = slimGithubWatch("github", details());
		expect(watch).toEqual({
			mode: "run",
			state: "watching",
			repo: "o/r",
			run,
		});
		// A step that has not started has no duration; a running one has the snapshot's.
		expect(watch?.run?.jobs[0]?.steps?.map((step) => step.durationSeconds)).toEqual([
			1,
			41,
			undefined,
		]);
	});

	test("is undefined for another tool, another op's details or a shape that is not a watch", () => {
		expect(slimGithubWatch("bash", details())).toBeUndefined();
		expect(slimGithubWatch("github", { repo: "o/r", runId: 7 })).toBeUndefined();
		expect(slimGithubWatch("github", undefined)).toBeUndefined();
		expect(slimGithubWatch("github", details({ mode: "branch" }))).toBeUndefined();
		expect(slimGithubWatch("github", details({ state: "done" }))).toBeUndefined();
		expect(
			slimGithubWatch("github", { watch: { mode: "run", state: "watching" } }),
		).toBeUndefined();
	});

	test("a job without steps keeps none, and malformed jobs, steps and durations are skipped", () => {
		const watch = slimGithubWatch(
			"github",
			details({
				run: {
					id: 7,
					jobs: [
						{ id: 1, name: "no steps" },
						{ id: "x", name: "bad id" },
						null,
						{
							id: 2,
							steps: [
								{ number: 0.5, name: "bad number" },
								{ number: 1, durationSeconds: -3 },
								{ number: 2, name: "ok", durationSeconds: 2.9 },
							],
						},
					],
				},
			}),
		);
		const jobs = watch?.run?.jobs;
		expect(jobs?.map((job) => job.name)).toEqual(["no steps", "job-2"]);
		expect(jobs?.[0]).not.toHaveProperty("steps");
		expect(jobs?.[1]?.steps).toEqual([
			{ number: 1, name: "step-1" },
			{ number: 2, name: "ok", durationSeconds: 2 },
		]);
	});

	test("a commit watch before any run, and a settled watch's failed logs", () => {
		expect(
			slimGithubWatch("github", {
				watch: { mode: "commit", state: "watching", repo: "o/r", runs: [] },
			}),
		).toEqual({ mode: "commit", state: "watching", repo: "o/r", runs: [] });
		const long = "x".repeat(WATCH_TAIL_CHARS + 10);
		const watch = slimGithubWatch(
			"github",
			details({
				state: "completed",
				failedLogs: [
					{ runId: 7, jobName: "test", available: true, tail: long },
					{ runId: 7, jobName: "lint", available: false, unavailableReason: "expired" },
					{ jobName: "no run id", available: true },
				],
			}),
		);
		expect(watch?.failedLogs).toHaveLength(2);
		expect(watch?.failedLogs?.[0]?.tail).toHaveLength(WATCH_TAIL_CHARS);
		expect(watch?.failedLogs?.[1]).toEqual({
			runId: 7,
			jobName: "lint",
			available: false,
			unavailableReason: "expired",
		});
	});

	test("clips long names", () => {
		const watch = slimGithubWatch(
			"github",
			details({ run: { id: 7, jobs: [{ id: 1, name: "n".repeat(WATCH_TEXT_CHARS + 50) }] } }),
		);
		expect(watch?.run?.jobs[0]?.name).toHaveLength(WATCH_TEXT_CHARS);
	});
});

describe("sameGithubWatch", () => {
	test("a poll that only moved the counter is the same watch; a finished step is not", () => {
		const a = slimGithubWatch("github", details());
		expect(sameGithubWatch(a, slimGithubWatch("github", details({ pollCount: 9 })))).toBe(true);
		const next = structuredClone(run);
		next.jobs[0]!.steps![1] = {
			number: 2,
			name: "Run tests",
			status: "completed",
			conclusion: "success",
			durationSeconds: 50,
		};
		expect(sameGithubWatch(a, slimGithubWatch("github", details({ run: next })))).toBe(false);
		expect(sameGithubWatch(a, undefined)).toBe(false);
		expect(sameGithubWatch(undefined, undefined)).toBe(true);
	});
});
