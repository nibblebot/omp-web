import { beforeEach, describe, expect, test } from "bun:test";
import { activateFeatures, featureCommand } from "../../features/registry";
import { setState, state } from "../../state";

describe("review feature", () => {
	beforeEach(async () => {
		await activateFeatures(["review"]);
	});

	test("/todo opens the todos modal", () => {
		setState("modal", null);
		featureCommand("todo")?.command.run("");
		expect(state.modal).toBe("todos");
	});

	test("/git rejects arguments and leaves the modal closed", () => {
		setState("modal", null);
		featureCommand("git")?.command.run("x");
		expect(state.modal).toBeNull();
	});
});
