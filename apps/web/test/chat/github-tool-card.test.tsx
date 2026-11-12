/**
 * The github card through the real `ToolCard` dispatch, rendered with solid's SSR runtime: the HTML is
 * what the card puts in the DOM. A job that is closed (passed) keeps its steps out of the DOM.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import type { WireGithubJob, WireGithubWatch } from "#lib/wire/protocol";
import { ToolCard } from "../../components/chat/tools/ToolCard";
import { Markdown } from "../../components/ui/Markdown";
import { setState, state, type ToolItem } from "../../state";
import { installJsxShim, restoreJsxShim } from "../web.testkit";

const original = { toolsExpanded: state.toolsExpanded, toolCards: state.display.toolCards };

beforeEach(() => {
	installJsxShim({
		onElement: (type, props) =>
			type === Markdown ? { value: `<div class="md">${String(props.src)}</div>` } : undefined,
	});
	setState("toolsExpanded", false);
	setState("display", "toolCards", "expanded");
});

afterAll(() => {
	restoreJsxShim();
	setState("toolsExpanded", original.toolsExpanded);
	setState("display", "toolCards", original.toolCards);
});

const passedJob: WireGithubJob = {
	id: 1,
	name: "lint",
	status: "completed",
	conclusion: "success",
	durationSeconds: 36,
	steps: [
		{
			number: 1,
			name: "ZZ-PASSED-STEP",
			status: "completed",
			conclusion: "success",
			durationSeconds: 9,
		},
	],
};
const failedJob: WireGithubJob = {
	id: 2,
	name: "test",
	status: "completed",
	conclusion: "failure",
	durationSeconds: 125,
	steps: [
		{ number: 1, name: "Checkout", status: "completed", conclusion: "success", durationSeconds: 3 },
		{
			number: 2,
			name: "ZZ-FAILED-STEP",
			status: "completed",
			conclusion: "failure",
			durationSeconds: 96,
		},
		{ number: 3, name: "Upload coverage", status: "completed", conclusion: "skipped" },
	],
};
const runningJob: WireGithubJob = {
	id: 3,
	name: "build",
	status: "in_progress",
	steps: [
		{ number: 1, name: "Checkout", status: "completed", conclusion: "success", durationSeconds: 3 },
		{ number: 2, name: "ZZ-RUNNING-STEP", status: "in_progress", durationSeconds: 41 },
		{ number: 3, name: "ZZ-QUEUED-STEP", status: "queued" },
	],
};
const watch = (state: WireGithubWatch["state"], ...jobs: WireGithubJob[]): WireGithubWatch => ({
	mode: "run",
	state,
	repo: "o/r",
	run: { id: 7, workflowName: "CI", branch: "main", jobs },
});

const call = (over: Partial<ToolItem>): ToolItem => ({
	kind: "tool",
	id: 1,
	toolCallId: "call_1",
	name: "github",
	args: { op: "run_watch", run: "7" },
	status: "done",
	output: "ZZ-OUTPUT",
	...over,
});
const render = (item: ToolItem) => renderToString(() => createComponent(ToolCard, { item }));

describe("GithubToolCard", () => {
	test("a running watch lists its running job's steps with state and duration; a passed job stays closed", () => {
		const html = render(
			call({ status: "running", watch: watch("watching", passedJob, runningJob) }),
		);
		expect(html).toContain("github-tool");
		expect(html).toContain("CI");
		expect(html).toContain("step 2/3 ZZ-RUNNING-STEP");
		expect(html).toContain("ZZ-RUNNING-STEP");
		expect(html).toContain("ZZ-QUEUED-STEP");
		expect(html).toContain("41s");
		// The passed job's step list is not in the DOM until it is opened.
		expect(html).not.toContain("ZZ-PASSED-STEP");
		expect(html).toContain("lint");
		expect(html).not.toContain("ZZ-OUTPUT");
	});

	test("a settled failed watch keeps the failed job open, marks the step and shows the failure", () => {
		const html = render(
			call({
				status: "error",
				details: { watch: watch("completed", passedJob, failedJob) },
			}),
		);
		expect(html).toContain("ZZ-FAILED-STEP");
		expect(html).toContain("failed at #2 ZZ-FAILED-STEP");
		expect(html).toContain("1m36s");
		expect(html).toContain('data-state="failure"');
		expect(html).toContain('data-state="skipped"');
		expect(html).not.toContain("ZZ-PASSED-STEP");
	});

	test("failed log tails stay out of the DOM until opened", () => {
		const base = watch("completed", failedJob);
		const html = render(
			call({
				status: "error",
				details: {
					watch: {
						...base,
						failedLogs: [{ runId: 7, jobName: "test", available: true, tail: "ZZ-LOG-TAIL" }],
					},
				},
			}),
		);
		expect(html).toContain("gh-log");
		expect(html).not.toContain("ZZ-LOG-TAIL");
	});

	test("a watch before its first poll waits, and any other op is the generic card", () => {
		expect(render(call({ status: "running", output: "" }))).toContain("Waiting for workflow jobs");
		const other = render(
			call({
				args: { op: "search_prs", query: "x" },
				details: { repo: "o/r" },
				output: "ZZ-OUTPUT",
			}),
		);
		expect(other).not.toContain("github-tool");
		// The generic card is a closed <details>: its header carries the args summary.
		expect(other).toContain("search_prs");
	});
});
