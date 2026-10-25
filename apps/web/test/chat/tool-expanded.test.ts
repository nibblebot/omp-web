/**
 * A tool card stays expanded while its call runs, and a call parked on a background job
 * runs as long as the job does, though the call itself returned.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { toolExpanded } from "../../components/chat/tools/ToolCardShell";
import { setState, state, type ToolItem } from "../../state";

const originalExpanded = state.toolsExpanded;

beforeEach(() => {
	setState("toolsExpanded", false);
});

afterAll(() => {
	setState("toolsExpanded", originalExpanded);
});

const bash = (over: Partial<ToolItem> = {}): ToolItem => ({
	kind: "tool",
	id: 1,
	toolCallId: "call_1",
	name: "bash",
	args: { command: "make" },
	status: "done",
	output: "",
	...over,
});

describe("toolExpanded", () => {
	test("a running call is expanded and a settled one is folded", () => {
		expect(toolExpanded(bash({ status: "running" }))).toBe(true);
		expect(toolExpanded(bash())).toBe(false);
	});

	test("a call parked on a running job is expanded until the job settles", () => {
		const background = {
			jobId: "bg_1",
			type: "bash",
			state: "running" as const,
			jobIds: ["bg_1"],
			startedAt: 1,
		};
		expect(toolExpanded(bash({ background }))).toBe(true);
		expect(toolExpanded(bash({ background: { ...background, state: "completed" } }))).toBe(false);
	});

	test("the expand toggle opens every card", () => {
		setState("toolsExpanded", true);
		expect(toolExpanded(bash())).toBe(true);
	});
});
