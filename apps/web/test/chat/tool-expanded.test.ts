/**
 * A tool card stays expanded while its call runs, and a call parked on a background job
 * runs as long as the job does, though the call itself returned.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createRowExpansion, toolExpanded } from "../../components/chat/tools/ToolCardShell";
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

describe("createRowExpansion", () => {
	// Under bun's SSR build of solid the Ctrl+O reset effect never runs; the per-card choice,
	// the expanded flag and the note label are plain signal reads and are what these cover.
	test("a card with hidden rows offers a note, and tapping it opens only that card", () => {
		const item = bash();
		const rows = createRowExpansion(() => item);
		const folded = rows.noteLabel(24);
		expect(folded).toBeDefined();
		expect(rows.expanded()).toBe(false);

		rows.toggle();
		expect(rows.expanded()).toBe(true);
		// The note stays so the card can fold again, with a different action.
		expect(rows.noteLabel(24)).toBeDefined();
		expect(rows.noteLabel(24)).not.toBe(folded);

		rows.toggle();
		expect(rows.expanded()).toBe(false);
		expect(createRowExpansion(() => item).expanded()).toBe(false);
	});

	test("no note without hidden rows, and none when Ctrl+O or a running call already shows all", () => {
		expect(createRowExpansion(() => bash()).noteLabel(0)).toBeUndefined();
		expect(createRowExpansion(() => bash({ status: "running" })).noteLabel(24)).toBeUndefined();
		setState("toolsExpanded", true);
		const rows = createRowExpansion(() => bash());
		expect(rows.expanded()).toBe(true);
		expect(rows.noteLabel(24)).toBeUndefined();
	});
});
