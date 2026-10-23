import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "vite";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { featureSizes } from "../build/feature-sizes";
import type { FeatureSizeManifest } from "../build/feature-sizes";

afterAll(cleanupTempDirs);

// Each fixture module logs a unique marker so the test can find its emitted
// chunk without depending on vite's chunk naming. Top-level side effects keep
// every module alive through minification.
const FIXTURE: Record<string, string> = {
	"main.ts": [
		'import "./core-lib";',
		'import "./main.css";',
		'console.info("CORE_ENTRY_MARK");',
		'void import("./features/analysis");',
		'void import("./features/plan");',
		"",
	].join("\n"),
	"main.css": ".CORE_CSS_MARK { color: red; }\n",
	"core-lib.ts": 'console.info("CORE_LIB_MARK");\n',
	"shared.ts": 'console.info("SHARED_MARK");\n',
	"extra.ts": 'console.info("EXTRA_MARK");\n',
	"features/analysis.ts": [
		'import "../shared";',
		'import "./analysis.css";',
		'console.info("ANALYSIS_MARK");',
		'void import("../extra");',
		"",
	].join("\n"),
	"features/analysis.css": ".ANALYSIS_CSS_MARK { color: blue; }\n",
	"features/plan.ts": [
		'import "../shared";',
		'import "../core-lib";',
		'console.info("PLAN_MARK");',
		"",
	].join("\n"),
};

describe("featureSizes build plugin (real vite build over fixture feature entries)", () => {
	const root = realpathSync(tempDir("feature-sizes-"));
	const outDir = join(root, "dist");
	let manifest: FeatureSizeManifest;

	/** The single emitted asset whose content contains `marker`. */
	function assetWith(marker: string): string {
		const hits = Object.keys(manifest.chunks).filter((file) =>
			readFileSync(join(outDir, file), "utf8").includes(marker),
		);
		expect(hits).toHaveLength(1);
		return hits[0]!;
	}

	beforeAll(async () => {
		for (const [path, source] of Object.entries(FIXTURE)) {
			const abs = join(root, path);
			mkdirSync(join(abs, ".."), { recursive: true });
			writeFileSync(abs, source);
		}
		await build({
			root,
			configFile: false,
			logLevel: "silent",
			plugins: [featureSizes({ featuresDir: join(root, "features") })],
			build: {
				outDir,
				emptyOutDir: true,
				rollupOptions: { input: join(root, "main.ts") },
			},
		});
		manifest = JSON.parse(
			readFileSync(join(outDir, "feature-sizes.json"), "utf8"),
		) as FeatureSizeManifest;
	}, 60_000);

	test("emits a version-1 manifest whose sizes match the emitted files", () => {
		expect(manifest.version).toBe(1);
		expect(manifest.chunks).not.toHaveProperty(["feature-sizes.json"]);
		for (const [file, size] of Object.entries(manifest.chunks)) {
			const body = readFileSync(join(outDir, file));
			expect(size.bytes).toBe(statSync(join(outDir, file)).size);
			expect(size.gzip).toBe(gzipSync(body, { level: 9 }).byteLength);
		}
	});

	test("a chunk shared by two features is listed under both", () => {
		const shared = assetWith("SHARED_MARK");
		expect(manifest.features.analysis).toContain(shared);
		expect(manifest.features.plan).toContain(shared);
		expect(manifest.core).not.toContain(shared);
	});

	test("a feature-private chunk is listed only under its feature", () => {
		const analysis = manifest.features.analysis ?? [];
		const plan = manifest.features.plan ?? [];
		expect(analysis).toContain(assetWith("ANALYSIS_MARK"));
		expect(plan).toContain(assetWith("PLAN_MARK"));
		expect(plan).not.toContain(assetWith("ANALYSIS_MARK"));
		expect(analysis).not.toContain(assetWith("PLAN_MARK"));
	});

	test("a chunk statically reachable from the app entry is core even when a feature imports it", () => {
		const coreLib = assetWith("CORE_LIB_MARK");
		expect(manifest.core).toContain(coreLib);
		expect(manifest.features.plan).not.toContain(coreLib);
		expect(manifest.features.analysis).not.toContain(coreLib);
		expect(manifest.core).toContain(assetWith("CORE_ENTRY_MARK"));
	});

	test("a dynamic import made by a feature belongs to that feature", () => {
		const extra = assetWith("EXTRA_MARK");
		expect(manifest.features.analysis).toContain(extra);
		expect(manifest.features.plan).not.toContain(extra);
		expect(manifest.core).not.toContain(extra);
	});

	test("CSS is attributed to the feature that imports it; entry CSS is core", () => {
		const analysisCss = assetWith("ANALYSIS_CSS_MARK");
		expect(analysisCss.endsWith(".css")).toBe(true);
		expect(manifest.features.analysis).toContain(analysisCss);
		expect(manifest.features.plan).not.toContain(analysisCss);
		expect(manifest.core).not.toContain(analysisCss);
		expect(manifest.core).toContain(assetWith("CORE_CSS_MARK"));
	});

	test("core plus feature lists cover every emitted asset, and lists name only emitted assets", () => {
		const claimed = new Set([...manifest.core, ...Object.values(manifest.features).flat()]);
		expect([...claimed].filter((file) => !(file in manifest.chunks))).toEqual([]);
		expect(Object.keys(manifest.chunks).filter((file) => !claimed.has(file))).toEqual([]);
	});

	test("feature ids absent from the build are omitted", () => {
		expect(manifest.features).not.toHaveProperty(["debug"]);
	});
});
