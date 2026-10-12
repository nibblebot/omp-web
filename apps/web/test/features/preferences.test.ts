import { describe, expect, test } from "bun:test";
import { FEATURES } from "../../features/manifest";
import { resolveFeaturePreferences } from "../../features/preferences";

describe("resolveFeaturePreferences", () => {
	test("uses manifest defaults without stored choices", () => {
		expect(Object.entries(resolveFeaturePreferences(null))).toEqual(
			FEATURES.map((feature) => [feature.id, feature.defaultEnabled]),
		);
	});

	test("ignores obsolete and unknown ids while preserving valid stored choices", () => {
		const prefs = resolveFeaturePreferences(
			JSON.stringify({ voice: true, unknown: false, analysis: false, debug: true }),
		);
		expect(prefs).toEqual({ ...resolveFeaturePreferences(null), analysis: false, debug: true });
		expect(prefs).not.toHaveProperty("voice");
		expect(prefs).not.toHaveProperty("unknown");
	});
});
