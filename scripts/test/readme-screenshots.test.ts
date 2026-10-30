import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { checkReadmeImages, screenshotRefs } from "../screenshots/readme-refs";
import { outputFiles } from "../screenshots/scenes";

afterAll(cleanupTempDirs);

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/** A screenshots directory holding the named (empty) files. */
function screenshotsWith(...names: string[]): string {
	const dir = join(tempDir("readme-shots-"), "docs", "screenshots");
	mkdirSync(dir, { recursive: true });
	for (const name of names) writeFileSync(join(dir, name), "");
	return dir;
}

describe("README images", () => {
	test("the README only references screenshots the script produces, and they are on disk", () => {
		const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
		expect(checkReadmeImages(readme, join(repoRoot, "docs", "screenshots"))).toEqual([]);
	});

	test("finds references in HTML, markdown and absolute URLs, once each", () => {
		const readme = [
			`<source srcset="docs/screenshots/hero-dark.webp" media="(prefers-color-scheme: dark)">`,
			`<img src="docs/screenshots/hero-light.webp" width="100%">`,
			`![x](docs/screenshots/fleet-sidebar-dark.webp)`,
			`[big](https://raw.githubusercontent.com/o/r/main/docs/screenshots/hero-dark.webp#x)`,
		].join("\n");
		expect(screenshotRefs(readme)).toEqual([
			"hero-dark.webp",
			"hero-light.webp",
			"fleet-sidebar-dark.webp",
		]);
	});

	test("accepts produced scheme variants and the architecture SVGs that are on disk", () => {
		const dir = screenshotsWith("hero-light.webp", "architecture-dark.svg");
		const readme = `<img src="docs/screenshots/hero-light.webp"><img src="docs/screenshots/architecture-dark.svg">`;
		expect(checkReadmeImages(readme, dir)).toEqual([]);
	});

	test("flags a file the script does not produce, even when it is on disk", () => {
		const dir = screenshotsWith("omp-web-demo.gif", "hero.webp");
		const readme = `<img src="docs/screenshots/omp-web-demo.gif"><img src="docs/screenshots/hero.webp">`;
		expect(checkReadmeImages(readme, dir)).toEqual([
			"README references docs/screenshots/omp-web-demo.gif, which scripts/screenshots/scenes.ts does not produce",
			"README references docs/screenshots/hero.webp, which scripts/screenshots/scenes.ts does not produce",
		]);
	});

	test("flags a produced file that is not on disk", () => {
		const dir = screenshotsWith();
		const problems = checkReadmeImages(`![x](docs/screenshots/phone-sidebar-dark.webp)`, dir);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("phone-sidebar-dark.webp");
		expect(problems[0]).toContain("not on disk");
	});

	test("every scene ships in both schemes", () => {
		const names = outputFiles();
		for (const name of names) {
			const twin = name.includes("-light.")
				? name.replace("-light.", "-dark.")
				: name.replace("-dark.", "-light.");
			expect(names).toContain(twin);
		}
	});
});
