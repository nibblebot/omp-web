import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { activateFeatures, featureCommand, isFeatureEnabled } from "../../features/registry";
import { FEATURE_IDS } from "../../features/manifest";
import { markFeaturesActive } from "../../features/preferences";
import { setState, state } from "../../state";

// The isolated gate runs every file in one process: leaving Review active here
// would make `/git` an enabled feature's command for later files
// (prompt/commands.test.ts asserts the disabled-feature notice), so the
// baseline active set goes back in afterAll.
const baselineActiveIds = FEATURE_IDS.filter(isFeatureEnabled);

afterAll(() => {
	markFeaturesActive(baselineActiveIds);
});

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
