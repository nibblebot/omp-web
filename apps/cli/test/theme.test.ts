import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { themeDoc } from "#lib/themes/test/fixtures.testkit";
import { main } from "../theme";

afterAll(cleanupTempDirs);

interface Run {
	code: number;
	out: string;
	err: string;
}

async function run(argv: string[]): Promise<Run> {
	const out: string[] = [];
	const err: string[] = [];
	const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
	return { code, out: out.join("\n"), err: err.join("\n") };
}

function themeFile(name: string, contents: unknown): string {
	const path = join(tempDir("omp-web-theme-cli-"), name);
	writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
	return path;
}

describe("omp-web theme check", () => {
	test("a valid file exits 0 and prints the name, id and resolved tokens per variant", async () => {
		const result = await run(["check", themeFile("my-theme.json", themeDoc("My Theme"))]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("My Theme (my-theme)");
		expect(result.out).toContain("dark variant");
		expect(result.out).toContain("light variant");
		expect(result.out).toMatch(/--bg: #1e1e2e/);
		// Derived tokens are resolved, not just the core ones.
		expect(result.out).toMatch(/--tool-shell: \S+/);
		expect(result.err).toBe("");
	});

	test("contrast warnings print and do not change the exit code", async () => {
		const doc = themeDoc("Faint", { light: false }) as {
			variants: { dark: Record<string, string> };
		};
		doc.variants.dark.text = "#1f1f2e";
		doc.variants.dark.muted = "#202030";
		const result = await run(["check", themeFile("faint.json", doc)]);
		expect(result.code).toBe(0);
		expect(result.out).toMatch(/text on [\w-]+: \d+\.\d+:1 \(min [\d.]+:1\)/);
	});

	test("a bundled built-in file checks clean of errors", async () => {
		const result = await run([
			"check",
			join(import.meta.dir, "../../../lib/themes/builtin/gruvbox.json"),
		]);
		expect(result.code).toBe(0);
		expect(result.out).toContain("(gruvbox)");
	});

	test("schema errors exit 1 and every error is listed", async () => {
		const result = await run([
			"check",
			themeFile("broken.json", {
				schemaVersion: 1,
				name: "",
				variants: { dark: { bg: "red" } },
				extra: true,
			}),
		]);
		expect(result.code).toBe(1);
		expect(result.out).toBe("");
		const errors = result.err.split("\n").filter((l) => l.startsWith("error: "));
		expect(errors.length).toBeGreaterThan(2);
	});

	test("invalid JSON, a bad stem and a non-.json name are errors with exit 1", async () => {
		const badJson = await run(["check", themeFile("syntax.json", "{ nope")]);
		expect(badJson.code).toBe(1);
		expect(badJson.err).toContain("invalid JSON");

		const badStem = await run(["check", themeFile("Bad Stem.json", themeDoc("X"))]);
		expect(badStem.code).toBe(1);
		expect(badStem.err).toContain("error:");

		const notJson = await run(["check", themeFile("theme.txt", themeDoc("X"))]);
		expect(notJson.code).toBe(1);
		expect(notJson.err).toContain(".json");
	});

	test("usage problems and unreadable files exit 2", async () => {
		expect((await run([])).code).toBe(2);
		expect((await run(["check"])).code).toBe(2);
		expect((await run(["bogus", "x.json"])).code).toBe(2);
		const missing = await run(["check", join(tempDir("omp-web-theme-cli-"), "absent.json")]);
		expect(missing.code).toBe(2);
		expect(missing.err).toContain("cannot read");
	});
});
