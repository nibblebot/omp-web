import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { FEATURE_IDS } from "../../features/manifest";
import {
	activateFeatures,
	featureCommand,
	featureDock,
	isFeatureEnabled,
} from "../../features/registry";
import { setState, state } from "../../state";

// The git feature is in development, so only activateFeatures can load it. The baseline
// active set goes back in afterAll: leaving it active would make `/git` an enabled command
// for later files in the same process (prompt/commands.test.ts asserts the in-development notice).
const baselineActiveIds = FEATURE_IDS.filter(isFeatureEnabled);

afterAll(async () => {
	await activateFeatures(baselineActiveIds);
});

describe("git feature", () => {
	beforeEach(async () => {
		await activateFeatures(["git"]);
		setState({ modal: null, dock: null });
	});

	test("/git rejects arguments and opens no dock", () => {
		featureCommand("git")!.command.run("x");
		expect(state.dock).toBeNull();
	});

	test("bare /git opens the review dock", () => {
		featureCommand("git")!.command.run("");
		expect(state.dock).toEqual({ kind: "review" });
	});

	test("/annotations rejects arguments and bare /annotations opens its sheet", () => {
		featureCommand("annotations")!.command.run("x");
		expect(state.modal).toBeNull();
		featureCommand("annotations")!.command.run("");
		expect(state.modal).toBe("annotations");
	});

	test("fills the review dock slot only while the feature is active", async () => {
		expect(featureDock("review")?.title).toBe("Git review");
		await activateFeatures([]);
		expect(featureDock("review")).toBeUndefined();
	});
});
