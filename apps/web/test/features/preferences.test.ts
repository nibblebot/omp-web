import { afterEach, describe, expect, test } from "bun:test";
import { FEATURES_KEY } from "../../features/manifest";
import {
	featurePreferences,
	resolveFeaturePreferences,
	setFeaturePreference,
} from "../../features/preferences";
import { installLocalStorageShim, restoreBrowserGlobals } from "../web.testkit";

describe("resolveFeaturePreferences", () => {
	test("ignores obsolete and unknown ids while preserving valid stored choices", () => {
		const prefs = resolveFeaturePreferences(
			JSON.stringify({ voice: true, unknown: false, analysis: false, debug: true }),
		);
		expect(prefs).toEqual({ ...resolveFeaturePreferences(null), analysis: false, debug: true });
		expect(prefs).not.toHaveProperty("voice");
		expect(prefs).not.toHaveProperty("unknown");
	});

	test("an in-development feature resolves off whatever is stored", () => {
		expect(resolveFeaturePreferences(JSON.stringify({ analysis: true })).analysis).toBe(false);
		expect(resolveFeaturePreferences(null).analysis).toBe(false);
	});
});

describe("setFeaturePreference", () => {
	afterEach(restoreBrowserGlobals);

	test("enabling an in-development feature changes nothing and writes no storage", () => {
		installLocalStorageShim();
		const before = { ...featurePreferences() };
		setFeaturePreference("analysis", true);
		expect(featurePreferences().analysis).toBe(false);
		expect(featurePreferences()).toEqual(before);
		expect(localStorage.getItem(FEATURES_KEY)).toBeNull();
	});
});
