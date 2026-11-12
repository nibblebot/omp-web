import { describe, expect, test } from "bun:test";
import { taskSpawnSteps } from "../../chat/task-steps";

describe("taskSpawnSteps", () => {
	test("a single spawn lists its steps in order with no label", () => {
		expect(taskSpawnSteps({ agent: "task", steps: ["a", "b", "c"], solutionSpace: "x" })).toEqual([
			{ index: 0, steps: ["a", "b", "c"] },
		]);
	});

	test("a call with a task text, no args or malformed args has no plan", () => {
		expect(taskSpawnSteps({ task: "do it" })).toEqual([]);
		expect(taskSpawnSteps({ description: "d" })).toEqual([]);
		expect(taskSpawnSteps(null)).toEqual([]);
		expect(taskSpawnSteps(undefined)).toEqual([]);
		expect(taskSpawnSteps("steps")).toEqual([]);
		expect(taskSpawnSteps({ steps: "one" })).toEqual([]);
	});

	test("an empty steps array has no plan", () => {
		expect(taskSpawnSteps({ steps: [] })).toEqual([]);
		expect(taskSpawnSteps({ tasks: [{ steps: [] }] })).toEqual([]);
	});

	test("non-string and blank entries are dropped, order kept", () => {
		expect(taskSpawnSteps({ steps: ["a", 3, "  ", null, "b"] })).toEqual([
			{ index: 0, steps: ["a", "b"] },
		]);
		expect(taskSpawnSteps({ steps: [1, "   "] })).toEqual([]);
	});

	test("a batch lists each stepped item by its position, skipping task items", () => {
		const plans = taskSpawnSteps({
			context: "shared",
			tasks: [
				{ steps: ["a", "b"] },
				{ task: "plain" },
				{ name: "Tokens", steps: ["c"] },
				{ name: "  ", steps: ["d"] },
				{ steps: "bad" },
				null,
			],
		});
		expect(plans).toEqual([
			{ index: 0, label: "Task 1", steps: ["a", "b"] },
			{ index: 2, label: "Tokens", steps: ["c"] },
			{ index: 3, label: "Task 4", steps: ["d"] },
		]);
	});

	test("an empty batch has no plan and ignores a top-level steps field", () => {
		expect(taskSpawnSteps({ context: "c", tasks: [] })).toEqual([]);
		expect(taskSpawnSteps({ tasks: [{ task: "x" }], steps: ["ignored"] })).toEqual([]);
	});
});
