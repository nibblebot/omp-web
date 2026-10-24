import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FEATURE_IDS, type FeatureId } from "../../features/manifest";
import { activateFeatures, featureComposerBars, isFeatureEnabled } from "../../features/registry";
import { JobsBar } from "../../components/jobs/JobsBar";

// The jobs feature is in development, so only activateFeatures can load it. The baseline
// active set goes back in afterAll so later files in the same process see the real defaults.
let baselineFeatures: FeatureId[] = [];

beforeAll(() => {
	baselineFeatures = FEATURE_IDS.filter(isFeatureEnabled);
});

afterAll(async () => {
	await activateFeatures(baselineFeatures);
});

describe("composer bars slot", () => {
	test("an active feature's bars mount above the composer, and a disabled one contributes none", async () => {
		await activateFeatures([]);
		expect(featureComposerBars()).toEqual([]);
		await activateFeatures(["jobs"]);
		expect(featureComposerBars()).toEqual([JobsBar]);
		await activateFeatures([]);
		expect(featureComposerBars()).toEqual([]);
	});
});
