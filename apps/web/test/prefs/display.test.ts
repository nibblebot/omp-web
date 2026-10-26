import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	booleanPref,
	choicePref,
	defaultDisplayPrefs,
	DISPLAY_PREFS,
	loadDisplayPrefs,
	saveDisplayPref,
	type DisplayStorage,
} from "../../prefs/display";
import { setDisplayPref, state } from "../../state";
import { installLocalStorageShim, restoreBrowserGlobals } from "../web.testkit";

/** A Map-backed Storage double. */
function memoryStorage(initial: Record<string, string> = {}): DisplayStorage & {
	entries: Map<string, string>;
} {
	const entries = new Map(Object.entries(initial));
	return {
		entries,
		getItem: (key) => entries.get(key) ?? null,
		setItem: (key, value) => void entries.set(key, value),
	};
}

describe("omp.display.* preferences", () => {
	test("every key lives under omp.display.", () => {
		for (const pref of Object.values(DISPLAY_PREFS)) expect(pref.key).toStartWith("omp.display.");
	});

	test("nothing stored loads the defaults", () => {
		const storage = memoryStorage();
		expect(loadDisplayPrefs(storage)).toEqual(defaultDisplayPrefs());
		expect(loadDisplayPrefs(storage).softFade).toBe(false);
		expect(storage.entries.size).toBe(0);
	});

	test("a saved value round-trips through storage", () => {
		const storage = memoryStorage();
		saveDisplayPref("softFade", true, storage);
		expect(storage.entries.get("omp.display.softFade")).toBe("true");
		expect(loadDisplayPrefs(storage).softFade).toBe(true);
		saveDisplayPref("softFade", false, storage);
		expect(storage.entries.get("omp.display.softFade")).toBe("false");
		expect(loadDisplayPrefs(storage).softFade).toBe(false);
	});

	test("an invalid stored boolean falls back to the default", () => {
		for (const raw of ["yes", "1", "TRUE", "", "null", "{}"]) {
			expect(loadDisplayPrefs(memoryStorage({ "omp.display.softFade": raw })).softFade).toBe(false);
		}
	});

	test("width loads default, accepts its presets and rejects anything else", () => {
		expect(loadDisplayPrefs(memoryStorage()).width).toBe("default");
		for (const width of ["narrow", "default", "wide", "full"] as const) {
			expect(loadDisplayPrefs(memoryStorage({ "omp.display.width": width })).width).toBe(width);
		}
		for (const raw of ["Wide", "820px", ""]) {
			expect(loadDisplayPrefs(memoryStorage({ "omp.display.width": raw })).width).toBe("default");
		}
	});

	test("tool cards default to expanded with 20 rows and accept only their choices", () => {
		const defaults = loadDisplayPrefs(memoryStorage());
		expect(defaults.toolCards).toBe("expanded");
		expect(defaults.toolRows).toBe("20");
		for (const mode of ["collapsed", "consolidated", "expanded"] as const) {
			expect(loadDisplayPrefs(memoryStorage({ "omp.display.toolCards": mode })).toolCards).toBe(
				mode,
			);
		}
		for (const rows of ["10", "20", "40", "all"] as const) {
			expect(loadDisplayPrefs(memoryStorage({ "omp.display.toolRows": rows })).toolRows).toBe(rows);
		}
		const bad = memoryStorage({ "omp.display.toolCards": "chips", "omp.display.toolRows": "30" });
		expect(loadDisplayPrefs(bad).toolCards).toBe("expanded");
		expect(loadDisplayPrefs(bad).toolRows).toBe("20");
	});

	test("a storage that throws loads defaults and drops writes without failing", () => {
		const broken: DisplayStorage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(loadDisplayPrefs(broken)).toEqual(defaultDisplayPrefs());
		expect(() => saveDisplayPref("softFade", true, broken)).not.toThrow();
		expect(loadDisplayPrefs(undefined)).toEqual(defaultDisplayPrefs());
	});

	test("a boolean pref defaults to its fallback and parses only true and false", () => {
		const on = booleanPref("probe", true);
		expect(on.key).toBe("omp.display.probe");
		expect(on.fallback).toBe(true);
		expect(on.parse("true")).toBe(true);
		expect(on.parse("false")).toBe(false);
		expect(on.parse("maybe")).toBeUndefined();
		expect(on.serialize(false)).toBe("false");
	});

	test("a choice pref accepts only its listed values", () => {
		const rows = choicePref("probeRows", ["10", "20", "all"], "20");
		expect(rows.key).toBe("omp.display.probeRows");
		expect(rows.fallback).toBe("20");
		expect(rows.parse("all")).toBe("all");
		expect(rows.parse("40")).toBeUndefined();
		expect(rows.parse("ALL")).toBeUndefined();
		expect(rows.parse("")).toBeUndefined();
		expect(rows.serialize("10")).toBe("10");
	});
});

describe("setDisplayPref", () => {
	beforeEach(installLocalStorageShim);
	afterEach(() => {
		setDisplayPref("softFade", false);
		restoreBrowserGlobals();
	});

	test("applies to the store and persists the value", () => {
		setDisplayPref("softFade", true);
		expect(state.display.softFade).toBe(true);
		expect(globalThis.localStorage.getItem("omp.display.softFade")).toBe("true");
		expect(loadDisplayPrefs().softFade).toBe(true);
		setDisplayPref("softFade", false);
		expect(state.display.softFade).toBe(false);
		expect(loadDisplayPrefs().softFade).toBe(false);
	});
});
