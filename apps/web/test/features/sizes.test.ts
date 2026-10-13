import { describe, expect, test } from "bun:test";
import type { FeatureId } from "../../features/manifest";
import {
	featureOwnSize,
	featureSizeTotals,
	parseFeatureSizes,
	type FeatureSizeManifest,
} from "../../features/sizes";

const manifest: FeatureSizeManifest = {
	version: 1,
	chunks: {
		"assets/index.js": { bytes: 1000, gzip: 400 },
		"assets/index.css": { bytes: 100, gzip: 50 },
		"assets/analysis.js": { bytes: 300, gzip: 120 },
		"assets/shared.js": { bytes: 200, gzip: 80 },
		"assets/goals.js": { bytes: 500, gzip: 190 },
	},
	core: ["assets/index.js", "assets/index.css"],
	features: {
		analysis: ["assets/analysis.js", "assets/shared.js"],
		goals: ["assets/goals.js", "assets/shared.js"],
	},
};

describe("featureSizeTotals", () => {
	test("core alone when no features are enabled", () => {
		expect(featureSizeTotals(manifest, [])).toEqual({ bytes: 1100, gzip: 450 });
	});

	test("a chunk shared by two enabled features is counted once", () => {
		expect(featureSizeTotals(manifest, ["analysis", "goals"])).toEqual({
			bytes: 1100 + 300 + 200 + 500,
			gzip: 450 + 120 + 80 + 190,
		});
	});

	test("duplicate ids do not double-count", () => {
		expect(featureSizeTotals(manifest, ["analysis", "analysis"])).toEqual(
			featureSizeTotals(manifest, ["analysis"]),
		);
	});

	test("features absent from the build and unknown ids contribute nothing", () => {
		const ids: FeatureId[] = ["debug", "nope" as FeatureId];
		for (const id of ids) {
			expect(featureSizeTotals(manifest, [id])).toEqual({ bytes: 1100, gzip: 450 });
		}
	});
});

describe("featureOwnSize", () => {
	test("includes the shared chunk", () => {
		expect(featureOwnSize(manifest, "analysis")).toEqual({ bytes: 500, gzip: 200 });
	});

	test("null for a feature the build does not contain", () => {
		expect(featureOwnSize(manifest, "debug")).toBeNull();
	});
});

describe("parseFeatureSizes", () => {
	test("accepts a version 1 manifest", () => {
		expect(parseFeatureSizes(manifest)).toEqual(manifest);
	});

	test("drops feature keys that are not feature ids", () => {
		const parsed = parseFeatureSizes({ ...manifest, features: { ...manifest.features, nope: [] } });
		expect(parsed?.features).not.toHaveProperty("nope");
	});

	test("rejects other versions", () => {
		expect(parseFeatureSizes({ ...manifest, version: 2 })).toBeNull();
	});

	test("rejects malformed chunk sizes", () => {
		expect(
			parseFeatureSizes({ ...manifest, chunks: { "assets/index.js": { bytes: "1000", gzip: 1 } } }),
		).toBeNull();
	});

	test("rejects non-object bodies (dev server HTML fallback)", () => {
		expect(parseFeatureSizes(null)).toBeNull();
		expect(parseFeatureSizes("<!doctype html>")).toBeNull();
	});
});
