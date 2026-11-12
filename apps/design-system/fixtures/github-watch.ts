import type {
	WireGithubJob,
	WireGithubRun,
	WireGithubStep,
	WireGithubWatch,
} from "#lib/wire/protocol";
import type { ToolItem } from "../../web/state";

/**
 * GithubToolCard fixtures. `details.watch` mirrors the SDK's GhRunWatchViewDetails (pi-tui
 * tools/github.ts) as `run_watch` returns it; a call still running carries the last snapshot as
 * `watch` (the frame the session sends on every poll) and no `details`.
 */

const base = { kind: "tool", args: null, output: "" } as const;

const REPO = "nibblebot/omp-web";
const SHA = "9f3c2ab41d7e0c5b6a8f1e2d3c4b5a69788796a5";

type StepRow = [name: string, conclusion: string | "running" | "queued", seconds?: number];

/** Steps numbered from 1 in the order given; `running` and `queued` have no conclusion. */
function steps(rows: StepRow[]): WireGithubStep[] {
	return rows.map(([name, outcome, durationSeconds], index) => ({
		number: index + 1,
		name,
		status: outcome === "running" ? "in_progress" : outcome === "queued" ? "queued" : "completed",
		...(outcome === "running" || outcome === "queued" ? {} : { conclusion: outcome }),
		...(durationSeconds !== undefined ? { durationSeconds } : {}),
	}));
}

function job(
	id: number,
	name: string,
	outcome: string,
	rows: StepRow[],
	durationSeconds?: number,
): WireGithubJob {
	return {
		id,
		name,
		status: outcome === "running" ? "in_progress" : outcome === "queued" ? "queued" : "completed",
		...(outcome === "running" || outcome === "queued" ? {} : { conclusion: outcome }),
		...(durationSeconds !== undefined ? { durationSeconds } : {}),
		url: `https://github.com/${REPO}/actions/runs/18204331877/job/${id}`,
		steps: steps(rows),
	};
}

function run(
	id: number,
	workflowName: string,
	outcome: string,
	jobs: WireGithubJob[],
	branch = "fix/outbox-retry",
): WireGithubRun {
	return {
		id,
		workflowName,
		displayTitle: "Retry unacked commands after a reconnect",
		status: outcome === "running" ? "in_progress" : outcome === "queued" ? "queued" : "completed",
		...(outcome === "running" || outcome === "queued" ? {} : { conclusion: outcome }),
		branch,
		headSha: SHA,
		url: `https://github.com/${REPO}/actions/runs/${id}`,
		jobs,
	};
}

const SETUP: StepRow[] = [
	["Set up job", "success", 1],
	["Run actions/checkout@v4", "success", 3],
	["Run oven-sh/setup-bun@v2", "success", 4],
	["Install dependencies", "success", 17],
];

const lintJob = job(
	71201,
	"lint",
	"success",
	[...SETUP, ["Run oxlint", "success", 9], ["Post Run actions/checkout@v4", "success", 0]],
	36,
);
const typesJob = job(
	71202,
	"types",
	"success",
	[...SETUP, ["Run tsgo", "success", 22], ["Post Run actions/checkout@v4", "success", 0]],
	49,
);

function watch(
	state: WireGithubWatch["state"],
	watched: WireGithubRun,
	extra: Partial<WireGithubWatch> = {},
): WireGithubWatch {
	return {
		mode: "run",
		state,
		repo: REPO,
		branch: watched.branch,
		headSha: SHA,
		run: watched,
		...extra,
	};
}

const runArgs = { op: "run_watch", run: "18204331877" };

/** GithubToolCard: a watch mid-run. lint and types passed, tests are on step 5 of 6, the build has not started. */
const runningRun = run(18204331877, "CI", "running", [
	lintJob,
	typesJob,
	job(
		71203,
		"test",
		"running",
		[
			...SETUP,
			["Run bun run test", "running", 41],
			["Upload coverage", "queued"],
			["Post Run actions/checkout@v4", "queued"],
		],
		63,
	),
	job(71204, "build", "queued", [
		["Set up job", "queued"],
		["Run actions/checkout@v4", "queued"],
		["Run bun run build:web", "queued"],
	]),
]);
export const githubWatchRunningTool: ToolItem = {
	...base,
	id: 9201,
	toolCallId: "call_github_9201",
	name: "github",
	status: "running",
	args: runArgs,
	output: "# Watching GitHub Actions Run #18204331877\n\nStatus: in_progress",
	watch: watch("watching", runningRun),
};

/** GithubToolCard: running, before the first poll answered. */
export const githubWatchWaitingTool: ToolItem = {
	...base,
	id: 9202,
	toolCallId: "call_github_9202",
	name: "github",
	status: "running",
	args: runArgs,
	output: "",
};

/** GithubToolCard: a watch that ended green. */
const passedRun = run(18204331877, "CI", "success", [
	lintJob,
	typesJob,
	job(
		71203,
		"test",
		"success",
		[
			...SETUP,
			["Run bun run test", "success", 138],
			["Upload coverage", "success", 6],
			["Post Run actions/checkout@v4", "success", 0],
		],
		171,
	),
	job(
		71204,
		"build",
		"success",
		[
			["Set up job", "success", 1],
			["Run actions/checkout@v4", "success", 3],
			["Run bun run build:web", "success", 54],
		],
		62,
	),
]);
export const githubWatchPassedTool: ToolItem = {
	...base,
	id: 9203,
	toolCallId: "call_github_9203",
	name: "github",
	status: "done",
	args: runArgs,
	output:
		"# GitHub Actions Run #18204331877\n\nStatus: completed\nConclusion: success\n\nAll jobs passed.",
	details: {
		repo: REPO,
		runId: 18204331877,
		status: "completed",
		conclusion: "success",
		watch: { ...watch("completed", passedRun), pollCount: 14 },
	},
};

/** GithubToolCard: a failed step (later steps skipped), a cancelled job, and the failed job's captured log tail. */
const failedRun = run(18204331877, "CI", "failure", [
	lintJob,
	job(
		71203,
		"test",
		"failure",
		[
			...SETUP,
			["Run bun run test", "failure", 96],
			["Upload coverage", "skipped"],
			["Post Run actions/checkout@v4", "success", 0],
		],
		123,
	),
	job(
		71204,
		"build",
		"cancelled",
		[
			["Set up job", "success", 1],
			["Run actions/checkout@v4", "success", 2],
			["Run bun run build:web", "cancelled", 8],
		],
		14,
	),
]);
export const githubWatchFailedTool: ToolItem = {
	...base,
	id: 9204,
	toolCallId: "call_github_9204",
	name: "github",
	status: "error",
	args: runArgs,
	output:
		"# GitHub Actions Run #18204331877\n\nStatus: completed\nConclusion: failure\n\nRun failed.",
	details: {
		repo: REPO,
		runId: 18204331877,
		status: "completed",
		conclusion: "failure",
		failedJobs: ["test"],
		watch: watch("completed", failedRun, {
			failedLogs: [
				{
					runId: 18204331877,
					workflowName: "CI",
					jobName: "test",
					conclusion: "failure",
					available: true,
					tail: [
						"apps/web/test/store/outbox.test.ts:",
						"(fail) outbox > re-sends an unacked command with its original id after a reconnect [31.20ms]",
						"error: expect(received).toBe(expected)",
						'Expected: "cmd_41"',
						'Received: "cmd_42"',
						"",
						" 1 fail",
						"Ran 612 tests across 88 files.",
						'error: script "test" exited with code 1',
					].join("\n"),
				},
			],
		}),
	},
};

/** GithubToolCard: a commit watch lists every workflow run of the commit; one is still going. */
export const githubWatchCommitTool: ToolItem = {
	...base,
	id: 9205,
	toolCallId: "call_github_9205",
	name: "github",
	status: "running",
	args: { op: "run_watch", branch: "fix/outbox-retry" },
	output: "# Watching GitHub Actions for 9f3c2ab",
	watch: {
		mode: "commit",
		state: "watching",
		repo: REPO,
		branch: "fix/outbox-retry",
		headSha: SHA,
		runs: [
			run(18204331877, "CI", "running", [
				lintJob,
				job(71203, "test", "running", [...SETUP, ["Run bun run test", "running", 12]], 34),
			]),
			run(18204331902, "Docs", "success", [
				job(
					71230,
					"build-docs",
					"success",
					[
						["Set up job", "success", 1],
						["Run astro build", "success", 28],
					],
					33,
				),
			]),
		],
	},
};

/** GithubToolCard: any other op is the generic card, as before. */
export const githubSearchPrsTool: ToolItem = {
	...base,
	id: 9206,
	toolCallId: "call_github_9206",
	name: "github",
	status: "done",
	args: { op: "search_prs", repo: REPO, query: "outbox retry is:merged" },
	output: [
		"# Search PRs",
		"",
		"Found 2 pull requests in nibblebot/omp-web.",
		"",
		"- #412 Retry unacked commands after a reconnect (merged)",
		"- #388 Keep the outbox across a session switch (merged)",
	].join("\n"),
	details: { repo: REPO },
};
