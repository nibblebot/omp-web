import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";
import { MAX_SETTING_VALUE_PATHS } from "#lib/wire/protocol";
import { BOOT_SETTING_PATHS } from "../../store/settings";
import { NOTIFY_SETTING_PATH } from "../../store/notify";

const WEB_ROOT = join(import.meta.dir, "..", "..");

/**
 * Settings read through `settingValue` outside the Settings sheet have an answer at attach only
 * when they are boot paths (the full model loads on first use of a sheet or the palette). A reader
 * added without its path would silently keep its default until a sheet had been opened.
 */
describe("boot setting paths", () => {
	test("every literal settingValue path read outside the Settings sheet is fetched at attach", async () => {
		const read = new Set<string>();
		const call = /settingValue(?:<[^>(]*>)?\(\s*["']([^"']+)["']/g;
		for await (const file of new Glob("**/*.{ts,tsx}").scan({ cwd: WEB_ROOT })) {
			// The sheet itself renders the loaded model; tests and fixtures read what they seed.
			if (file.startsWith("test/") || file.startsWith("components/settings/")) continue;
			const source = await Bun.file(join(WEB_ROOT, file)).text();
			for (const match of source.matchAll(call)) read.add(match[1]!);
		}
		expect(read.size).toBeGreaterThan(10);
		const missing = [...read].filter((path) => !BOOT_SETTING_PATHS.includes(path));
		expect(missing, "add these to BOOT_SETTING_PATHS (store/settings.ts)").toEqual([]);
	});

	test("the notification gates and the dynamic readers are boot paths", () => {
		for (const path of Object.values(NOTIFY_SETTING_PATH))
			expect(BOOT_SETTING_PATHS).toContain(path);
		for (const id of ["enabled", "ultrathink", "orchestrate", "workflow", "jevify"])
			expect(BOOT_SETTING_PATHS).toContain(`magicKeywords.${id}`);
	});

	test("the list has no duplicates and fits one getSettings call", () => {
		expect(new Set(BOOT_SETTING_PATHS).size).toBe(BOOT_SETTING_PATHS.length);
		expect(BOOT_SETTING_PATHS.length).toBeLessThanOrEqual(MAX_SETTING_VALUE_PATHS);
	});
});
