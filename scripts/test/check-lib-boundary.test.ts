import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { checkLibBoundary, checkWebFeatureBoundary } from "../check-lib-boundary";
import type { LibBoundaryFinding } from "../check-lib-boundary";

afterAll(cleanupTempDirs);

const checker = fileURLToPath(new URL("../check-lib-boundary.ts", import.meta.url));

type Findings = LibBoundaryFinding[];
type FixtureOptions = {
	tsconfig?: Record<string, unknown>;
	packageJson?: Record<string, unknown>;
};

/** Stand-in for apps/web/features/manifest.ts; `FEATURES` is the id source the checker reads. */
function featureManifest(ids: readonly string[]): string {
	return [
		"export interface FeatureInfo { id: string }",
		`export const FEATURES: readonly FeatureInfo[] = [${ids.map((id) => `{ id: ${JSON.stringify(id)} }`).join(", ")}];`,
	].join("\n");
}

function runChecker(root: string) {
	return Bun.spawnSync({
		cmd: [process.execPath, checker, root],
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
}

function writeRepo(files: Record<string, string>, options: FixtureOptions = {}): string {
	const root = tempDir("lib-boundary-");
	const manifests = {
		"package.json": JSON.stringify(
			options.packageJson ?? { name: "boundary-fixture", type: "module" },
		),
		"tsconfig.json": JSON.stringify(
			options.tsconfig ?? {
				compilerOptions: { target: "ESNext", module: "ESNext", moduleResolution: "Bundler" },
			},
		),
	};
	for (const [path, content] of Object.entries({ ...manifests, ...files })) {
		const target = join(root, path);
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	return root;
}

function findingAt(findings: Findings, code: Findings[number]["code"], file: string) {
	const finding = findings.find((candidate) => candidate.code === code && candidate.file === file);
	expect(finding).toBeDefined();
	return finding!;
}

function expectBoundary(findings: Findings, file: string, specifier: string, target: string): void {
	const finding = findingAt(findings, "boundary", file);
	expect(finding.message).toContain(specifier);
	expect(finding.message).toContain(target);
}

describe("library source boundaries", () => {
	test("a repository without lib has no findings", () => {
		const root = writeRepo({ "apps/web/entry.ts": 'import "./missing";' });
		expect(checkLibBoundary(root)).toEqual({ files: 0, findings: [] });
	});

	test("an empty lib has no findings", () => {
		const root = writeRepo({});
		mkdirSync(join(root, "lib"));
		expect(checkLibBoundary(root)).toEqual({ files: 0, findings: [] });
	});

	test.each([
		["production", "lib/alpha/index.ts", "../../apps/web/entry"],
		["test", "lib/alpha/index.test.ts", "../../apps/web/entry"],
		["testkit helper", "lib/alpha/fixtures.testkit.ts", "../../apps/web/entry"],
		["nested test", "lib/alpha/test/nested/index.test.ts", "../../../../apps/web/entry"],
		["hidden helper", "lib/alpha/.fixtures/helper.ts", "../../../apps/web/entry"],
	])("rejects outward imports from %s sources", (_name, file, specifier) => {
		const target = "apps/web/entry.ts";
		const root = writeRepo({
			[file]: `import { app } from "${specifier}";\nexport { app };`,
			[target]: "export const app = 1;",
		});
		const result = checkLibBoundary(root);
		expect(result.files).toBe(1);
		expectBoundary(result.findings, file, specifier, target);
	});

	test.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "d.ts", "d.mts", "d.cts"])(
		"scans .%s source files",
		(extension) => {
			const file = `lib/alpha/source.${extension}`;
			const specifier = "../../apps/web/entry";
			const root = writeRepo({
				[file]: `import "${specifier}";`,
				"apps/web/entry.ts": "export {};",
			});
			expectBoundary(checkLibBoundary(root).findings, file, specifier, "apps/web/entry.ts");
		},
	);

	test.each([
		["type-only import", 'import type { App } from "../../apps/web/entry";', "ts"],
		["export type", 'export type { App } from "../../apps/web/entry";', "ts"],
		["named re-export", 'export { app } from "../../apps/web/entry";', "ts"],
		["star re-export", 'export * from "../../apps/web/entry";', "ts"],
		["type star re-export", 'export type * from "../../apps/web/entry";', "ts"],
		["literal dynamic import", 'void import("../../apps/web/entry");', "ts"],
		["literal template import", "void import(`../../apps/web/entry`);", "ts"],
		["import-equals require", 'import app = require("../../apps/web/entry");', "ts"],
		["typeof import type", 'export type AppModule = typeof import("../../apps/web/entry");', "ts"],
		[
			"relative ambient module",
			'declare module "../../apps/web/entry" { export const app: number; }',
			"d.ts",
		],
	])("rejects a boundary escape through %s", (_name, source, extension) => {
		const file = `lib/alpha/entry.${extension}`;
		const root = writeRepo({
			[file]: source,
			"apps/web/entry.ts": "export type App = { value: string }; export const app = 1;",
		});
		expectBoundary(
			checkLibBoundary(root).findings,
			file,
			"../../apps/web/entry",
			"apps/web/entry.ts",
		);
	});

	test("rejects triple-slash reference paths escaping lib", () => {
		const file = "lib/alpha/globals.d.ts";
		const specifier = "../../apps/web/globals.d.ts";
		const root = writeRepo({
			[file]: `/// <reference path="${specifier}" />\nexport {};`,
			"apps/web/globals.d.ts": "declare const appVersion: string;",
		});
		expectBoundary(checkLibBoundary(root).findings, file, specifier, "apps/web/globals.d.ts");
	});

	test("reports unresolved relative dependencies at their source", () => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({ [file]: 'import { missing } from "./missing";\nexport { missing };' });
		const finding = findingAt(checkLibBoundary(root).findings, "unresolved", file);
		expect(finding.message).toContain("./missing");
		expect(finding.line).toBe(1);
	});
});

describe("permitted library dependencies and owner cycles", () => {
	test("allows an acyclic graph, TS substitution, declarations, builtins, and an installed package", () => {
		const root = writeRepo({
			"lib/alpha/index.ts": [
				'import { value } from "../beta/index.js";',
				'import type { Shape } from "../gamma/types";',
				'import { readFileSync } from "node:fs";',
				'import { join } from "path";',
				'import { file } from "bun";',
				'import { packageValue } from "fixture-package";',
				'const os = require("node:os");',
				"export { value, readFileSync, join, file, packageValue, os };",
				"export type { Shape };",
			].join("\n"),
			"lib/beta/index.ts": 'export { value } from "../gamma/value.mjs";',
			"lib/gamma/value.mts": "export const value = 1;",
			"lib/gamma/types.d.ts": "export interface Shape { value: number; }",
			"node_modules/fixture-package/package.json": JSON.stringify({
				name: "fixture-package",
				type: "module",
				exports: { ".": "./index.js" },
			}),
			"node_modules/fixture-package/index.js": "export const packageValue = 2;",
		});
		expect(checkLibBoundary(root)).toEqual({ files: 4, findings: [] });
	});

	test("ignores app-origin library imports, app cycles, and unresolved app imports", () => {
		const root = writeRepo({
			"lib/alpha/index.ts": 'export { value } from "../beta/index";',
			"lib/beta/index.ts": "export const value = 1;",
			"apps/web/index.ts": [
				'import "../../lib/alpha/index";',
				'import "../api/index";',
				'import "./does-not-exist";',
			].join("\n"),
			"apps/api/index.ts": 'import "../web/index";\nimport "../../lib/beta/index";',
		});
		expect(checkLibBoundary(root)).toEqual({ files: 2, findings: [] });
	});

	test("rejects an owner cycle assembled from separate production, test, and type files", () => {
		const root = writeRepo({
			"lib/alpha/outgoing.ts": 'import { value } from "../beta/value";\nexport { value };',
			"lib/alpha/value.ts": "export const value = 1;",
			"lib/beta/value.ts": "export const value = 2;",
			"lib/beta/outgoing.test.ts":
				'import type { Shape } from "../gamma/types";\nexport type { Shape };',
			"lib/gamma/types.d.ts": "export interface Shape { value: number; }",
			"lib/gamma/returning.d.ts": 'export type AlphaModule = typeof import("../alpha/value");',
		});
		const cycle = checkLibBoundary(root).findings.find((finding) => finding.code === "cycle");
		expect(cycle).toBeDefined();
		for (const owner of ["alpha", "beta", "gamma"]) {
			expect(cycle!.message).toContain(owner);
		}
		for (const site of [
			"lib/alpha/outgoing.ts",
			"lib/beta/outgoing.test.ts",
			"lib/gamma/returning.d.ts",
		]) {
			expect(cycle!.message).toContain(site);
		}
	});

	test("allows file-level cycles inside one library", () => {
		const root = writeRepo({
			"lib/alpha/a.ts": 'import { b } from "./b";\nexport const a = () => b;',
			"lib/alpha/b.ts": 'import { a } from "./a";\nexport const b = () => a;',
		});
		expect(checkLibBoundary(root)).toEqual({ files: 2, findings: [] });
	});
});

describe("loader calls and require origins", () => {
	test.each([
		["dynamic import", 'const path = "./target"; void import(path);'],
		["interpolated import", 'void import(`./${"target"}`);'],
		["require", 'const path = "./target"; require(path);'],
		["require.resolve", 'const path = "./target"; require.resolve(path);'],
		["module.require", 'const path = "./target"; module.require(path);'],
		["process.getBuiltinModule", 'const id = "node:module"; process.getBuiltinModule(id);'],
		["import.meta.resolve", 'const path = "./target"; import.meta.resolve(path);'],
		["Bun.resolveSync", 'const path = "./target"; Bun.resolveSync(path);'],
		["escaping local require", 'const load = require; load("./target");'],
		["exported require", "export const load = require;"],
		["require passed as argument", "consume(require);"],
	])("rejects %s rather than assuming a dependency origin", (_name, source) => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({
			[file]: source,
			"lib/alpha/target.ts": "export const value = 1;",
		});
		const finding = findingAt(checkLibBoundary(root).findings, "computed", file);
		expect(finding.message).toMatch(/import|require|load/i);
	});

	test.each([
		["require", 'require("../../apps/web/entry");'],
		["require.resolve", 'require.resolve("../../apps/web/entry");'],
		["module.require", 'module.require("../../apps/web/entry");'],
	])("resolves a static %s before enforcing the boundary", (_name, source) => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({
			[file]: source,
			"apps/web/entry.ts": "export const value = 1;",
		});
		expectBoundary(
			checkLibBoundary(root).findings,
			file,
			"../../apps/web/entry",
			"apps/web/entry.ts",
		);
	});

	test.each(["createRequire", "makeRequire"])(
		"allows a static loader from factory %s",
		(factory) => {
			const imported =
				factory === "createRequire" ? "createRequire" : "createRequire as makeRequire";
			const root = writeRepo({
				"lib/alpha/index.ts": [
					`import { ${imported} } from "node:module";`,
					`const load = ${factory}(import.meta.url);`,
					'const value = load("../beta/value");',
					'const path = load.resolve("../beta/value");',
					'const fs = load("node:fs");',
					"export { value, path, fs };",
				].join("\n"),
				"lib/beta/value.ts": "export const value = 1;",
			});
			expect(checkLibBoundary(root)).toEqual({ files: 2, findings: [] });
		},
	);

	test.each(["load", "load.resolve"])("checks static app dependencies through %s", (loader) => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({
			[file]: [
				'import { createRequire as makeRequire } from "node:module";',
				"const load = makeRequire(import.meta.url);",
				`${loader}("../../apps/web/entry");`,
			].join("\n"),
			"apps/web/entry.ts": "export {};",
		});
		expectBoundary(
			checkLibBoundary(root).findings,
			file,
			"../../apps/web/entry",
			"apps/web/entry.ts",
		);
	});

	test.each(["load", "load.resolve"])(
		"rejects computed paths through createRequire %s",
		(loader) => {
			const file = "lib/alpha/index.ts";
			const root = writeRepo({
				[file]: [
					'import { createRequire as makeRequire } from "node:module";',
					"const load = makeRequire(import.meta.url);",
					'const path = "./target";',
					`${loader}(path);`,
				].join("\n"),
				"lib/alpha/target.ts": "export {};",
			});
			const finding = findingAt(checkLibBoundary(root).findings, "computed", file);
			expect(finding.message).toMatch(/require|load/i);
		},
	);

	test.each([
		'new URL("../../apps/web/entry.ts", import.meta.url)',
		'"/different/repository/entry.js"',
	])("rejects createRequire with nonlocal base %s", (base) => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({
			[file]: [
				'import { createRequire as makeRequire } from "node:module";',
				`const load = makeRequire(${base});`,
				'load("./target");',
			].join("\n"),
			"lib/alpha/target.ts": "export const value = 1;",
			"apps/web/entry.ts": "export {};",
		});
		const finding = findingAt(checkLibBoundary(root).findings, "computed", file);
		expect(finding.message).toMatch(/createRequire|makeRequire|base|origin/i);
	});

	// Fixtures intentionally spell module loading dynamically: static imports cannot express the
	// runtime-selected loader forms the checker must recognise.
	test.each([
		[
			"a require result",
			['require("node:module").createRequire(import.meta.url)("../../apps/web/entry");'],
		],
		[
			"an aliased require result",
			[
				'const load = require("node:module").createRequire(import.meta.url);',
				'load("../../apps/web/entry");',
			],
		],
		[
			"a destructured require result",
			[
				'const { createRequire } = require("node:module");',
				"const load = createRequire(import.meta.url);",
				'load("../../apps/web/entry");',
			],
		],
		[
			"a process.getBuiltinModule result",
			[
				'const load = process.getBuiltinModule("node:module").createRequire(import.meta.url);',
				'load("../../apps/web/entry");',
			],
		],
		[
			"an awaited dynamic import",
			[
				'const namespace = await import("node:module");',
				"const load = namespace.createRequire(import.meta.url);",
				'load("../../apps/web/entry");',
			],
		],
	])("checks a createRequire loader from %s", (_name, lines) => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({
			[file]: [...lines, "export {};"].join("\n"),
			"apps/web/entry.ts": "export const value = 1;",
		});
		expectBoundary(
			checkLibBoundary(root).findings,
			file,
			"../../apps/web/entry",
			"apps/web/entry.ts",
		);
	});

	test.each([
		["import.meta.resolve", 'import.meta.resolve("../../apps/web/entry");'],
		["Bun.resolveSync", 'Bun.resolveSync("../../apps/web/entry", import.meta.dir);'],
	])("rejects a cross-library path through %s", (_name, source) => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({
			[file]: `${source}\nexport {};`,
			"apps/web/entry.ts": "export const value = 1;",
		});
		expectBoundary(
			checkLibBoundary(root).findings,
			file,
			"../../apps/web/entry",
			"apps/web/entry.ts",
		);
	});

	test("allows tracked module accessors and resolvers that stay inside lib", () => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({
			[file]: [
				'const direct = require("node:module").createRequire(import.meta.url);',
				'const { createRequire } = require("node:module");',
				"const destructured = createRequire(import.meta.url);",
				'const accessor = process.getBuiltinModule("node:module");',
				"const builtin = accessor.createRequire(import.meta.url);",
				'const namespace = await import("node:module");',
				"const dynamic = namespace.createRequire(import.meta.url);",
				'direct("./target");',
				'destructured("./target");',
				'builtin("./target");',
				'dynamic("./target");',
				'const resolved = import.meta.resolve("./target");',
				'const found = Bun.resolveSync("./target", import.meta.dir);',
				"export { resolved, found };",
			].join("\n"),
			"lib/alpha/target.ts": "export const value = 1;",
		});
		expect(checkLibBoundary(root)).toEqual({ files: 2, findings: [] });
	});
});

describe("resolver aliases and realpath boundaries", () => {
	test.each([
		["ordinary type import", 'import type value from "fixture-library";', "import"],
		["typed import-equals", 'import type value = require("fixture-library");', "require"],
	])("preserves package export conditions for %s", (_name, source, condition) => {
		const file = "lib/alpha/consumer.d.ts";
		const root = writeRepo(
			{
				[file]: `${source}\nexport type Value = typeof value;`,
				"lib/alpha/import-types.d.ts":
					"declare const value: { library: true }; export default value;",
				"apps/web/require-types.d.ts": "declare const value: { app: true }; export = value;",
			},
			{
				packageJson: {
					name: "fixture-library",
					type: "module",
					exports: {
						".": {
							import: { types: "./lib/alpha/import-types.d.ts" },
							require: { types: "./apps/web/require-types.d.ts" },
						},
					},
				},
			},
		);
		const result = checkLibBoundary(root);
		if (condition === "import") {
			expect(result).toEqual({ files: 2, findings: [] });
		} else {
			expectBoundary(result.findings, file, "fixture-library", "apps/web/require-types.d.ts");
		}
	});

	test("resolves a root tsconfig alias before rejecting its app target", () => {
		const file = "lib/alpha/index.ts";
		const specifier = "@root/apps/web/entry";
		const root = writeRepo(
			{
				[file]: `import { app } from "${specifier}";`,
				"apps/web/entry.ts": "export const app = 1;",
			},
			{ tsconfig: { compilerOptions: { baseUrl: ".", paths: { "@root/*": ["./*"] } } } },
		);
		expectBoundary(checkLibBoundary(root).findings, file, specifier, "apps/web/entry.ts");
	});

	test("reports an unresolved root alias rather than treating it as an npm package", () => {
		const file = "lib/alpha/index.ts";
		const specifier = "@root/apps/web/missing";
		const root = writeRepo(
			{ [file]: `import "${specifier}";` },
			{ tsconfig: { compilerOptions: { baseUrl: ".", paths: { "@root/*": ["./*"] } } } },
		);
		const finding = findingAt(checkLibBoundary(root).findings, "unresolved", file);
		expect(finding.message).toContain(specifier);
	});

	test("package imports cannot conceal an app dependency", () => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo(
			{
				[file]: 'import { app } from "#app";',
				"apps/web/entry.ts": "export const app = 1;",
			},
			{
				packageJson: {
					name: "boundary-fixture",
					type: "module",
					imports: { "#app": "./apps/web/entry.ts" },
				},
			},
		);
		expectBoundary(checkLibBoundary(root).findings, file, "#app", "apps/web/entry.ts");
	});

	test.each(["file", "directory"])("cannot import an app through a symlinked %s in lib", (kind) => {
		const file = "lib/alpha/index.ts";
		const specifier = kind === "file" ? "./linked" : "./linked/entry";
		const root = writeRepo({
			[file]: `import { app } from "${specifier}";`,
			"apps/web/entry.ts": "export const app = 1;",
		});
		symlinkSync(
			join(root, kind === "file" ? "apps/web/entry.ts" : "apps/web"),
			join(root, kind === "file" ? "lib/alpha/linked.ts" : "lib/alpha/linked"),
			kind === "file" ? "file" : "dir",
		);
		expectBoundary(checkLibBoundary(root).findings, file, specifier, "apps/web/entry.ts");
	});

	test("an npm package symlink cannot grant access to app code", () => {
		const file = "lib/alpha/index.ts";
		const root = writeRepo({
			[file]: 'import { app } from "fixture-app";',
			"apps/web/package.json": JSON.stringify({
				name: "fixture-app",
				type: "module",
				exports: { ".": "./entry.ts" },
			}),
			"apps/web/entry.ts": "export const app = 1;",
		});
		mkdirSync(join(root, "node_modules"));
		symlinkSync(join(root, "apps/web"), join(root, "node_modules/fixture-app"), "dir");
		expectBoundary(checkLibBoundary(root).findings, file, "fixture-app", "apps/web/entry.ts");
	});
});

describe("web feature boundaries", () => {
	test("rejects a static feature-entry import from core code", () => {
		const file = "apps/web/App.tsx";
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis", "review"]),
			"apps/web/features/analysis.tsx": "export const view = () => 1;",
			[file]:
				'import { view } from "./features/analysis";\nexport const App = () => <p>{view()}</p>;',
		});
		const finding = findingAt(checkWebFeatureBoundary(root).findings, "feature-boundary", file);
		expect(finding.message).toContain("analysis");
		expect(finding.message).toContain('"./features/analysis"');
		expect(finding.message).toContain("apps/web/features/analysis.tsx");
		expect(finding.message).toContain("import()");
		expect(finding.message).toContain("registry.ts");
		expect(finding.line).toBe(1);
	});

	test("rejects a static feature-entry re-export from core code", () => {
		const file = "apps/web/store/index.ts";
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis"]),
			"apps/web/features/analysis.tsx": "export const view = 1;",
			[file]: 'export { view } from "../features/analysis";',
		});
		const finding = findingAt(checkWebFeatureBoundary(root).findings, "feature-boundary", file);
		expect(finding.message).toContain("analysis");
	});

	test.each([
		["type import", 'import type { View } from "./features/analysis";\nexport type V = View;'],
		[
			"specifier type import",
			'import { type View } from "./features/analysis";\nexport type V = View;',
		],
		["type re-export", 'export type { View } from "./features/analysis";'],
		["specifier type re-export", 'export { type View } from "./features/analysis";'],
	])("allows a %s of a feature entry", (_name, source) => {
		const file = "apps/web/state.ts";
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis"]),
			"apps/web/features/analysis.tsx": "export interface View { id: string }",
			[file]: source,
		});
		expect(checkWebFeatureBoundary(root)).toEqual({ files: 1, findings: [] });
	});

	test("allows the registry's dynamic feature import from core code", () => {
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis"]),
			"apps/web/features/analysis.tsx": "export const view = () => 1;",
			"apps/web/index.tsx": 'export const load = () => import("./features/analysis");',
		});
		expect(checkWebFeatureBoundary(root)).toEqual({ files: 1, findings: [] });
	});

	test("allows core imports of the shared feature modules", () => {
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis"]),
			"apps/web/features/registry.ts": "export const activateFeatures = () => Promise.resolve();",
			"apps/web/features/preferences.ts": "export const preferredFeatureIds = () => [];",
			"apps/web/index.tsx": [
				'import { FEATURES } from "./features/manifest";',
				'import { activateFeatures } from "./features/registry";',
				'import { preferredFeatureIds } from "./features/preferences";',
				"export const start = () => activateFeatures(preferredFeatureIds() ?? FEATURES);",
			].join("\n"),
		});
		expect(checkWebFeatureBoundary(root)).toEqual({ files: 1, findings: [] });
	});

	test("treats only manifest ids as feature entries", () => {
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis"]),
			"apps/web/features/legacy.ts": "export const legacy = 1;",
			"apps/web/legacy.ts": 'import { legacy } from "./features/legacy";\nexport const v = legacy;',
		});
		expect(checkWebFeatureBoundary(root)).toEqual({ files: 1, findings: [] });
	});

	test("covers a new manifest id without hardcoding", () => {
		const file = "apps/web/panel/panel.ts";
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis", "quantum"]),
			"apps/web/features/quantum.ts": "export const quantum = 1;",
			[file]: 'import { quantum } from "../features/quantum";\nexport const v = quantum;',
		});
		const finding = findingAt(checkWebFeatureBoundary(root).findings, "feature-boundary", file);
		expect(finding.message).toContain("quantum");
		expect(finding.message).toContain("apps/web/features/quantum.ts");
	});

	test("scans core source only, ignoring app tests and feature internals", () => {
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis", "review"]),
			"apps/web/features/analysis.tsx":
				'import { review } from "./review";\nexport const v = review;',
			"apps/web/features/review.tsx": "export const review = 1;",
			"apps/web/test/analysis.test.ts": 'import { v } from "../features/analysis";',
			"apps/web/core.ts": "export const core = 1;",
		});
		expect(checkWebFeatureBoundary(root)).toEqual({ files: 1, findings: [] });
	});

	test("reports an unreadable feature manifest instead of throwing", () => {
		const root = writeRepo({ "apps/web/index.tsx": "export {};" });
		const finding = findingAt(
			checkWebFeatureBoundary(root).findings,
			"source",
			"apps/web/features/manifest.ts",
		);
		expect(finding.message).toContain("manifest");
	});

	test("reports a manifest whose FEATURES array cannot be read", () => {
		const root = writeRepo({
			"apps/web/features/manifest.ts": 'export const FEATURES = buildFeatures(["analysis"]);',
			"apps/web/App.tsx": 'import "./features/analysis";',
			"apps/web/features/analysis.tsx": "export {};",
		});
		const finding = findingAt(
			checkWebFeatureBoundary(root).findings,
			"parse",
			"apps/web/features/manifest.ts",
		);
		expect(finding.message).toContain("FEATURES");
	});

	test("a repository without apps/web has no findings", () => {
		const root = writeRepo({ "lib/alpha/index.ts": "export const value = 1;" });
		expect(checkWebFeatureBoundary(root)).toEqual({ files: 0, findings: [] });
	});
});

describe("library boundary CLI", () => {
	test("exits nonzero and identifies the origin and resolved app target", () => {
		const file = "lib/alpha/index.ts";
		const specifier = "../../apps/web/entry";
		const root = writeRepo({
			[file]: `import "${specifier}";`,
			"apps/web/entry.ts": "export {};",
		});
		const result = runChecker(root);
		expect(result.exitCode).toBe(1);
		const diagnostic = result.stderr.toString();
		expect(diagnostic).toContain(file);
		expect(diagnostic).toContain(specifier);
		expect(diagnostic).toContain("apps/web/entry.ts");
	});

	test("exits nonzero and identifies the feature entry a core file statically imports", () => {
		const file = "apps/web/App.tsx";
		const root = writeRepo({
			"apps/web/features/manifest.ts": featureManifest(["analysis"]),
			"apps/web/features/analysis.tsx": "export const view = 1;",
			[file]: 'import { view } from "./features/analysis";\nexport const App = () => view;',
		});
		const result = runChecker(root);
		expect(result.exitCode).toBe(1);
		const diagnostic = result.stderr.toString();
		expect(diagnostic).toContain(`[feature-boundary]`);
		expect(diagnostic).toContain(file);
		expect(diagnostic).toContain("apps/web/features/analysis.tsx");
		expect(result.stdout.toString()).toBe("");
	});

	test("prints one summary line per phase for a clean repository", () => {
		const root = writeRepo({
			"lib/alpha/index.ts": "export const value = 1;",
			"apps/web/features/manifest.ts": featureManifest(["analysis"]),
			"apps/web/features/analysis.tsx": "export const view = 1;",
			"apps/web/App.tsx": "export const App = 1;",
		});
		const result = runChecker(root);
		expect(result.exitCode).toBe(0);
		expect(result.stderr.toString()).toBe("");
		const summary = result.stdout.toString();
		expect(summary).toContain("Library boundary: 1 source files checked");
		expect(summary).toContain("no outward imports or cross-library cycles.");
		expect(summary).toContain("Web feature boundary: 1 core files checked");
		expect(summary).toContain("no static feature-entry imports.");
	});
});
