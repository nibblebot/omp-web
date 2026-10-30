import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import {
	isPartial,
	listShots,
	parseArgs,
	schemesFor,
	SHOT_IDS,
	UsageError,
} from "../screenshots/args";
import { listsAnimatedWebpDecoder } from "../screenshots/media";
import { outputFiles, SHOTS, STILLS } from "../screenshots/scenes";
import { syncOutput } from "../screenshots/sync";

afterAll(cleanupTempDirs);

describe("screenshots args", () => {
	test("defaults: everything, both schemes, with videos, no write", () => {
		const options = parseArgs([]);
		expect([options.only.size, options.schemes, options.hero, options.write]).toEqual([
			0,
			["light", "dark"],
			true,
			false,
		]);
		expect([options.list, options.help, isPartial(options)]).toEqual([false, false, false]);
		expect(schemesFor(options, "hero")).toEqual(["light", "dark"]);
	});

	test("--only takes a comma list and repeats; --no-hero and --write are flags", () => {
		const options = parseArgs([
			"--only",
			"hero,fleet-sidebar",
			"--only=settings",
			"--no-hero",
			"--write",
		]);
		expect([...options.only.keys()]).toEqual(["hero", "fleet-sidebar", "settings"]);
		expect([options.hero, options.write, isPartial(options)]).toEqual([false, true, true]);
		expect(schemesFor(options, "settings")).toEqual(["light", "dark"]);
		expect(schemesFor(options, "architecture")).toEqual([]);
	});

	test("--only accepts an output stem: that shot in that scheme", () => {
		const options = parseArgs(["--only", "hero-dark,tool-read-light,hero-phone"]);
		expect(schemesFor(options, "hero")).toEqual(["dark"]);
		expect(schemesFor(options, "tool-read")).toEqual(["light"]);
		expect(schemesFor(options, "hero-phone")).toEqual(["light", "dark"]);
		expect(schemesFor(options, "settings")).toEqual([]);
		// The same shot named twice adds up, in scheme order.
		const both = parseArgs(["--only", "hero-dark", "--only", "hero-light"]);
		expect(schemesFor(both, "hero")).toEqual(["light", "dark"]);
	});

	test("--scheme narrows every selected shot, repeatable or comma separated", () => {
		expect(schemesFor(parseArgs(["--scheme", "dark"]), "settings")).toEqual(["dark"]);
		expect(isPartial(parseArgs(["--scheme=dark"]))).toBe(true);
		expect(parseArgs(["--scheme", "dark,light"]).schemes).toEqual(["light", "dark"]);
		expect(isPartial(parseArgs(["--scheme", "dark", "--scheme", "light"]))).toBe(false);
		const options = parseArgs(["--only", "tool-read,hero", "--scheme", "light"]);
		expect(schemesFor(options, "tool-read")).toEqual(["light"]);
		expect(schemesFor(parseArgs(["--only", "hero", "--scheme", "dark"]), "hero")).toEqual(["dark"]);
	});

	test("--list and --help are flags", () => {
		expect(parseArgs(["--list"]).list).toBe(true);
		expect(parseArgs(["-h"]).help).toBe(true);
	});

	test("rejects unknown ids and schemes, a stem its --scheme excludes, missing values and unknown flags", () => {
		expect(() => parseArgs(["--only", "nope"])).toThrow(UsageError);
		expect(() => parseArgs(["--only", "hero-sepia"])).toThrow(UsageError);
		expect(() => parseArgs(["--only", "nope-dark"])).toThrow(UsageError);
		expect(() => parseArgs(["--only"])).toThrow(UsageError);
		expect(() => parseArgs(["--only="])).toThrow(UsageError);
		expect(() => parseArgs(["--scheme", "sepia"])).toThrow(UsageError);
		expect(() => parseArgs(["--scheme"])).toThrow(UsageError);
		expect(() => parseArgs(["--only", "hero-dark", "--scheme", "light"])).toThrow(UsageError);
		expect(() => parseArgs(["--wat"])).toThrow(UsageError);
	});

	test("every shot is selectable and listed once, with its kind", () => {
		for (const scene of STILLS) expect(SHOT_IDS).toContain(scene.id);
		expect(new Set(SHOT_IDS).size).toBe(SHOT_IDS.length);
		const lines = listShots().split("\n");
		expect(lines).toHaveLength(SHOTS.length);
		const kinds = Object.fromEntries(SHOTS.map((shot) => [shot.id, shot.kind]));
		expect([
			kinds.hero,
			kinds["hero-phone"],
			kinds["themes-grid"],
			kinds.architecture,
			kinds.settings,
		]).toEqual(["video", "video", "still", "svg", "still"]);
		for (const shot of SHOTS) {
			expect(lines.some((line) => line.startsWith(shot.id) && line.includes(shot.shows))).toBe(
				true,
			);
		}
	});
});

describe("screenshots scene list", () => {
	test("scene ids are unique and file names are produced once", () => {
		const ids = STILLS.map((scene) => scene.id);
		expect(new Set(ids).size).toBe(ids.length);
		const files = outputFiles();
		expect(new Set(files).size).toBe(files.length);
		expect(files).toContain("themes-grid-dark.webp");
		expect(files).toContain("hero-light.webp");
		expect(files).toContain("hero-phone-dark.webp");
		expect(files).toContain("architecture-dark.svg");
	});
});

/** Files whose content is their name's text before a `:`, so equal prefixes count as "same". */
const sameKey = async (a: string, b: string): Promise<boolean> =>
	readFileSync(a, "utf8").split(":")[0] === readFileSync(b, "utf8").split(":")[0];

function dirWith(files: Record<string, string>): string {
	const dir = tempDir("screenshots-sync-");
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

describe("listsAnimatedWebpDecoder", () => {
	test("needs the animated decoder, not just the still one", () => {
		const still = " VF...D webp                 WebP image\n";
		expect(listsAnimatedWebpDecoder(still)).toBe(false);
		expect(
			listsAnimatedWebpDecoder(`${still} V.S..D webp_anim            Animated WebP image\n`),
		).toBe(true);
	});
});

describe("syncOutput", () => {
	test("copies new and changed files, leaves identical ones untouched", async () => {
		const out = dirWith({ "a.webp": "px1:new-encode", "b.webp": "px2:x", "c.webp": "px3:x" });
		const target = dirWith({ "a.webp": "px1:old-encode", "b.webp": "other:x" });
		const result = await syncOutput(out, target, {
			files: ["a.webp", "b.webp", "c.webp"],
			same: sameKey,
		});
		expect(result).toEqual({ copied: ["b.webp", "c.webp"], unchanged: ["a.webp"], removed: [] });
		expect(readFileSync(join(target, "a.webp"), "utf8")).toBe("px1:old-encode");
		expect(readFileSync(join(target, "b.webp"), "utf8")).toBe("px2:x");
	});

	test("a full run deletes what the scene list no longer produces; a partial run deletes nothing", async () => {
		const out = dirWith({ "a.webp": "1" });
		const target = dirWith({ "a.webp": "1", "omp-web-demo.gif": "gif", "gone-light.webp": "x" });
		const partial = await syncOutput(out, target, { files: ["a.webp"], same: sameKey });
		expect(partial.removed).toEqual([]);
		expect(readdirSync(target).sort()).toEqual(["a.webp", "gone-light.webp", "omp-web-demo.gif"]);
		const full = await syncOutput(out, target, {
			files: ["a.webp"],
			keep: ["a.webp"],
			same: sameKey,
		});
		expect(full.removed).toEqual(["gone-light.webp", "omp-web-demo.gif"]);
		expect(readdirSync(target)).toEqual(["a.webp"]);
	});

	test("creates the target directory", async () => {
		const out = dirWith({ "a.svg": "<svg/>" });
		const target = join(dirWith({}), "nested", "screenshots");
		const result = await syncOutput(out, target, { files: ["a.svg"], same: sameKey });
		expect(result.copied).toEqual(["a.svg"]);
	});
});
