import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { BUILTIN_THEMES } from "../builtin";
import { loadThemes, themesDirFor } from "../loader";
import { themeDoc } from "./fixtures.testkit";

afterAll(cleanupTempDirs);

function themesDir(files: Record<string, unknown>): string {
	const dir = join(tempDir("omp-themes-"), "themes");
	mkdirSync(dir);
	for (const [file, content] of Object.entries(files)) {
		writeFileSync(join(dir, file), typeof content === "string" ? content : JSON.stringify(content));
	}
	return dir;
}

const BUILTIN_IDS = BUILTIN_THEMES.map((t) => t.id);

describe("themesDirFor", () => {
	test("is the themes folder next to the config file", () => {
		expect(themesDirFor("/home/me/.omp-web/config.json")).toBe("/home/me/.omp-web/themes");
	});
});

describe("loadThemes", () => {
	test("a missing directory means built-ins only, no failures", async () => {
		const dir = join(tempDir("omp-themes-"), "themes");
		const payload = await loadThemes(dir);
		expect(payload).toEqual({ dir, themes: [...BUILTIN_THEMES], failures: [] });
	});

	test("reports an absolute dir", async () => {
		const payload = await loadThemes("relative/themes-that-do-not-exist");
		expect(isAbsolute(payload.dir)).toBe(true);
	});

	test("customs follow the built-ins, sorted by name, with source custom", async () => {
		const dir = themesDir({
			"zebra.json": themeDoc("Aardvark"),
			"alpha.json": themeDoc("Zulu", { light: false }),
			"mid.json": themeDoc("Mango"),
		});
		const { themes, failures } = await loadThemes(dir);
		expect(failures).toEqual([]);
		expect(themes.map((t) => t.id)).toEqual([...BUILTIN_IDS, "zebra", "mid", "alpha"]);
		expect(themes.slice(BUILTIN_IDS.length).map((t) => [t.name, t.source])).toEqual([
			["Aardvark", "custom"],
			["Mango", "custom"],
			["Zulu", "custom"],
		]);
		expect(Object.keys(themes[BUILTIN_IDS.length + 2]!.variants)).toEqual(["dark"]);
	});

	test("a valid file with a built-in stem replaces it in place as modified", async () => {
		const dir = themesDir({
			"gruvbox.json": themeDoc("My Gruvbox"),
			"extra.json": themeDoc("Extra"),
		});
		const { themes, failures } = await loadThemes(dir);
		expect(failures).toEqual([]);
		expect(themes.map((t) => t.id)).toEqual([...BUILTIN_IDS, "extra"]);
		expect(themes[1]).toMatchObject({ id: "gruvbox", name: "My Gruvbox", source: "modified" });
		expect(themes[0]).toBe(BUILTIN_THEMES[0]!);
		expect(themes[2]).toBe(BUILTIN_THEMES[2]!);
	});

	test("an invalid file with a built-in stem is a failure and the built-in stays", async () => {
		const dir = themesDir({
			"catppuccin.json": { schemaVersion: 1, name: "Broken", variants: {} },
		});
		const { themes, failures } = await loadThemes(dir);
		expect(themes).toEqual([...BUILTIN_THEMES]);
		expect(themes[0]!.source).toBe("builtin");
		expect(failures).toEqual([
			{ file: "catppuccin.json", errors: ["variants: must define at least one of dark, light"] },
		]);
	});

	test("bad stems, bad JSON and schema errors are failures with reasons, valid files still load", async () => {
		const dir = themesDir({
			"My Theme.json": themeDoc("Spaces"),
			"broken.json": "{ not json",
			"newer.json": { ...themeDoc("Newer"), schemaVersion: 9 },
			"good.json": themeDoc("Good"),
		});
		const { themes, failures } = await loadThemes(dir);
		expect(themes.map((t) => t.id)).toEqual([...BUILTIN_IDS, "good"]);
		const byFile = Object.fromEntries(failures.map((f) => [f.file, f.errors]));
		expect(Object.keys(byFile).sort()).toEqual(["My Theme.json", "broken.json", "newer.json"]);
		expect(byFile["My Theme.json"]![0]).toStartWith("file name:");
		expect(byFile["broken.json"]![0]).toStartWith("cannot read file:");
		expect(byFile["newer.json"]![0]).toContain("newer than this omp-web supports");
	});

	test("ignores dotfiles and non-json files", async () => {
		const dir = themesDir({
			".hidden.json": themeDoc("Hidden"),
			"notes.txt": "hello",
			"theme.json.bak": "{}",
		});
		const { themes, failures } = await loadThemes(dir);
		expect(themes).toEqual([...BUILTIN_THEMES]);
		expect(failures).toEqual([]);
	});

	test("reads the directory on every call", async () => {
		const dir = themesDir({});
		expect((await loadThemes(dir)).themes).toHaveLength(BUILTIN_IDS.length);
		writeFileSync(join(dir, "late.json"), JSON.stringify(themeDoc("Late")));
		expect((await loadThemes(dir)).themes.map((t) => t.id)).toContain("late");
	});
});
