import type { BackgroundJob } from "../../web/chat/background-job";
import type { ToolItem } from "../../web/state";
import {
	bashDoneTool,
	bashErrorTool,
	evalDoneTool,
	taskDoneTool,
	taskErrorTool,
	taskRunningTool,
} from "./tools";

/**
 * Tool cards whose call returned while its job keeps running: running (the clock counts up
 * from `startedAt`), and settled completed, failed or cancelled. They reuse the settled
 * fixtures' calls, so the task cards keep the subagents `taskSubagentMap` seeds.
 */

const RUN_MS = 95_000;

const parked = (
	type: string,
	jobId: string,
	patch: Partial<BackgroundJob> = {},
): BackgroundJob => ({
	jobId,
	type,
	state: "running",
	jobIds: [jobId],
	startedAt: Date.now() - RUN_MS,
	...patch,
});

/** BashToolCard: a dev server backgrounded after its start result; the job's output keeps filling the card. */
export const bashBackgroundRunningTool: ToolItem = {
	...bashDoneTool,
	args: { command: "bun run dev", timeout: 600 },
	status: "done",
	output: [
		"$ vite --port 20898",
		"  VITE v7.1.2  ready in 412 ms",
		"  Local:   http://localhost:20898/",
		"  hmr update /apps/web/components/chat/tools/BashToolCard.tsx",
	].join("\n"),
	background: parked("bash", "bg_dev"),
};

/** BashToolCard: the backgrounded job finished, and its final output is the card's result. */
export const bashBackgroundCompletedTool: ToolItem = {
	...bashDoneTool,
	args: { command: "bun run build:web" },
	background: parked("bash", "bg_build", { state: "completed", durationMs: 74_000 }),
};

/** BashToolCard: the backgrounded job failed; the card reads as an error and the badge names the exit code. */
export const bashBackgroundFailedTool: ToolItem = {
	...bashErrorTool,
	background: parked("bash", "bg_tests", { state: "failed", durationMs: 31_000, exitCode: 1 }),
};

/** BashToolCard: the job was cancelled; the card is interrupted and keeps the output it got to. */
export const bashBackgroundCancelledTool: ToolItem = {
	...bashDoneTool,
	args: { command: "bun run profile --quick" },
	status: "interrupted",
	output: ["scenario 1/6 baseline ... ok", "scenario 2/6 fanout ..."].join("\n"),
	background: parked("bash", "bg_profile", { state: "cancelled", durationMs: 48_000 }),
};

/** EvalToolCard: a long cell backgrounded, still printing. */
export const evalBackgroundRunningTool: ToolItem = {
	...evalDoneTool,
	status: "done",
	args: {
		language: "python",
		code: ["import time", "for i in range(60):", "    print('tick', i)", "    time.sleep(2)"].join(
			"\n",
		),
	},
	output: ["tick 0", "tick 1", "tick 2", "tick 3"].join("\n"),
	background: parked("eval", "bg_cell"),
};

/** EvalToolCard: the cell finished in the background. */
export const evalBackgroundCompletedTool: ToolItem = {
	...evalDoneTool,
	background: parked("eval", "bg_cell_done", { state: "completed", durationMs: 120_000 }),
};

/** EvalToolCard: the cell failed in the background. */
export const evalBackgroundFailedTool: ToolItem = {
	...evalDoneTool,
	status: "error",
	output:
		'Traceback (most recent call last):\n  File "<cell>", line 3\nZeroDivisionError: division by zero',
	background: parked("eval", "bg_cell_failed", { state: "failed", durationMs: 8_000 }),
};

/** TaskToolCard: detached subagents still running after the call returned. */
export const taskBackgroundRunningTool: ToolItem = {
	...taskRunningTool,
	status: "done",
	background: parked("task", "Anna", { jobIds: ["Anna", "Bram", "Cleo"] }),
};

/** TaskToolCard: every detached subagent finished. */
export const taskBackgroundCompletedTool: ToolItem = {
	...taskDoneTool,
	background: parked("task", "Dara", {
		state: "completed",
		jobIds: ["Dara", "Eli"],
		durationMs: 124_000,
	}),
};

/** TaskToolCard: a detached subagent failed. */
export const taskBackgroundFailedTool: ToolItem = {
	...taskErrorTool,
	background: parked("task", "Ines", { state: "failed", jobIds: ["Ines"], durationMs: 31_000 }),
};
