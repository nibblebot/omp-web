import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { checkCssDurations, checkCssLoops } from "../check-css-durations";

afterAll(cleanupTempDirs);

function webCss(files: Record<string, string>): string {
	const root = tempDir("css-motion-");
	for (const [name, css] of Object.entries(files)) {
		const path = join(root, "apps/web", name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, css);
	}
	return root;
}

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

describe("checkCssLoops", () => {
	test("every infinite animation in the web stylesheets sits in a no-preference block", () => {
		expect(checkCssLoops(repoRoot)).toEqual([]);
	});

	test("flags an infinite animation outside a no-preference block", () => {
		const root = webCss({
			"styles/a.css": `.dot {\n\tanimation: pulse var(--dur-pulse) ease infinite;\n}\n`,
			"styles/b.css": `@media (prefers-reduced-motion: reduce) {\n\t.dot {\n\t\tanimation: pulse var(--dur-pulse) infinite;\n\t}\n}\n`,
		});
		expect(checkCssLoops(root).map((f) => `${f.file}:${f.line}`)).toEqual([
			"apps/web/styles/a.css:2",
			"apps/web/styles/b.css:3",
		]);
	});

	test("accepts a no-preference block, a finite animation and a comment", () => {
		const root = webCss({
			"styles/a.css": [
				"/* animation: pulse 1s infinite; */",
				".a { animation: flash var(--dur-pulse) 2; }",
				"@media (prefers-reduced-motion: no-preference) {",
				"\t.b {\n\t\tanimation: pulse var(--dur-pulse) infinite;\n\t}",
				"\t.c { animation-iteration-count: infinite; }",
				"}",
				".d { animation: none; }",
				"",
			].join("\n"),
		});
		expect(checkCssLoops(root)).toEqual([]);
	});

	test("a rule after the media block is outside it again", () => {
		const root = webCss({
			"styles/a.css": `@media (prefers-reduced-motion: no-preference) {\n\t.a { animation: x var(--dur-spin) infinite; }\n}\n.b {\n\tanimation: y var(--dur-spin) infinite;\n}\n`,
		});
		expect(checkCssLoops(root).map((f) => f.line)).toEqual([5]);
	});
});

describe("checkCssDurations", () => {
	test("the web stylesheets spell no literal duration outside the tokens", () => {
		expect(checkCssDurations(repoRoot)).toEqual([]);
	});
});
