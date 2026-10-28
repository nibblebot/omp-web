import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseThemeFile } from "#lib/themes/parse";
import type { ThemeEntry, ThemesPayload } from "#lib/themes/types";

type ThemeModule = typeof import("../../prefs/theme");
let m: ThemeModule;
let freshCount = 0;

type MediaListener = (e: { matches: boolean }) => void;

/** Process-global stubs for the browser APIs theme.ts touches; restored in afterAll. */
const installed: Array<{ key: string; original: PropertyDescriptor | undefined }> = [];
function installGlobal(key: string, value: unknown): void {
	installed.push({ key, original: Object.getOwnPropertyDescriptor(globalThis, key) });
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

interface StubElement {
	id: string;
	textContent: string;
}

const storage = new Map<string, string>();
let osPrefersLight = false;
let mediaListeners: MediaListener[] = [];
let root: { dataset: Record<string, string>; style: Record<string, string> };
let headChildren: StubElement[] = [];

/** Simulate the OS colour-scheme flipping; fires every registered change listener. */
function setOsPreference(prefersLight: boolean): void {
	osPrefersLight = prefersLight;
	for (const listener of mediaListeners) listener({ matches: prefersLight });
}

beforeAll(() => {
	installGlobal("localStorage", {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	});
	installGlobal("window", {
		matchMedia: () => ({
			get matches() {
				return osPrefersLight;
			},
			addEventListener: (_type: string, listener: MediaListener) => {
				mediaListeners.push(listener);
			},
		}),
	});
});

beforeEach(async () => {
	// A fresh module per test: theme.ts keeps the applied payload in module state.
	m = (await import(`../../prefs/theme.ts?fresh=${++freshCount}`)) as ThemeModule;
	storage.clear();
	mediaListeners = [];
	osPrefersLight = false;
	root = { dataset: {}, style: { background: "#123456" } };
	headChildren = [];
	installGlobal("document", {
		documentElement: root,
		head: {
			append: (el: StubElement) => {
				headChildren = headChildren.filter((child) => child !== el);
				headChildren.push(el);
			},
		},
		createElement: (): StubElement => ({ id: "", textContent: "" }),
		getElementById: (id: string) => headChildren.find((el) => el.id === id) ?? null,
	});
});

afterAll(() => {
	for (const { key, original } of installed.reverse()) {
		if (original === undefined) Reflect.deleteProperty(globalThis, key);
		else Object.defineProperty(globalThis, key, original);
	}
});

const CORE = {
	dark: {
		bg: "#1e1e2e",
		panel: "#313244",
		text: "#cdd6f4",
		muted: "#a6adc8",
		border: "#45475a",
		accent: "#89b4fa",
		success: "#a6e3a1",
		warning: "#f9e2af",
		error: "#f38ba8",
	},
	light: {
		bg: "#eff1f5",
		panel: "#ffffff",
		text: "#4c4f69",
		muted: "#575a6e",
		border: "#ccd0da",
		accent: "#1a55d6",
		success: "#256f1a",
		warning: "#92400e",
		error: "#c20d34",
	},
};

/** A resolved theme with the requested variants, built through the real parser. */
function theme(id: string, schemes: Array<"dark" | "light"> = ["dark", "light"]): ThemeEntry {
	const variants: Record<string, unknown> = {};
	for (const scheme of schemes) variants[scheme] = { ...CORE[scheme] };
	const result = parseThemeFile(id, { schemaVersion: 1, name: id, variants }, "custom");
	if (!result.ok) throw new Error(result.errors.join("; "));
	return result.entry;
}

const PAYLOAD: ThemesPayload = {
	dir: "/themes",
	themes: [theme("catppuccin"), theme("pair"), theme("night", ["dark"]), theme("day", ["light"])],
	failures: [],
};

const stored = () => ({
	mode: storage.get("omp-web:theme-mode"),
	linked: storage.get("omp-web:theme-linked"),
	light: storage.get("omp-web:theme-light"),
	dark: storage.get("omp-web:theme-dark"),
});

describe("defaults and root attributes", () => {
	test("nothing stored: system, linked, catppuccin on both schemes", () => {
		expect(m.currentThemeSelection()).toEqual({
			mode: "system",
			linked: true,
			light: "catppuccin",
			dark: "catppuccin",
		});
	});

	test("the old single theme key is ignored", () => {
		storage.set("omp-web:theme", "omp-dark");
		m.initTheme();
		expect(m.currentThemeSelection().mode).toBe("system");
		expect(root.dataset.themeVariant).toBe("catppuccin/dark");
	});

	test("initTheme sets scheme and variant and drops the inline boot background", () => {
		osPrefersLight = true;
		m.initTheme();
		expect(root.dataset.scheme).toBe("light");
		expect(root.dataset.themeVariant).toBe("catppuccin/light");
		expect(root.style.background).toBe("");
	});

	test("malformed stored values fall back to defaults", () => {
		storage.set("omp-web:theme-mode", "sepia");
		storage.set("omp-web:theme-dark", '"><script>');
		expect(m.currentThemeSelection()).toMatchObject({ mode: "system", dark: "catppuccin" });
	});
});

describe("mode", () => {
	test("system follows the OS while the OS changes", () => {
		m.initTheme();
		expect(root.dataset.scheme).toBe("dark");
		setOsPreference(true);
		expect(root.dataset.scheme).toBe("light");
		expect(root.dataset.themeVariant).toBe("catppuccin/light");
		setOsPreference(false);
		expect(root.dataset.scheme).toBe("dark");
	});

	test("an explicit mode ignores the OS", () => {
		m.setThemeMode("dark");
		m.initTheme();
		setOsPreference(true);
		expect(root.dataset.scheme).toBe("dark");
		expect(m.effectiveScheme()).toBe("dark");
		m.setThemeMode("light");
		expect(root.dataset.scheme).toBe("light");
		expect(stored().mode).toBe("light");
	});

	test("each scheme renders its own stored theme", () => {
		m.applyThemesPayload(PAYLOAD);
		m.selectSchemeTheme("light", "pair");
		m.setThemeMode("dark");
		expect(root.dataset.themeVariant).toBe("catppuccin/dark");
		m.setThemeMode("light");
		expect(root.dataset.themeVariant).toBe("pair/light");
	});
});

describe("linking", () => {
	beforeEach(() => m.applyThemesPayload(PAYLOAD));

	test("a theme with both variants sets both schemes", () => {
		const selection = m.selectLinkedTheme("pair");
		expect(selection).toMatchObject({ linked: true, light: "pair", dark: "pair" });
		expect(root.dataset.themeVariant).toBe("pair/dark");
	});

	test("a single-variant theme unlinks and sets only its scheme", () => {
		const selection = m.selectLinkedTheme("day");
		expect(selection).toEqual({ mode: "system", linked: false, light: "day", dark: "catppuccin" });
		m.setThemeMode("light");
		expect(root.dataset.themeVariant).toBe("day/light");
	});

	test("unlinking keeps both ids", () => {
		m.selectLinkedTheme("pair");
		expect(m.setThemeLinked(false)).toMatchObject({ linked: false, light: "pair", dark: "pair" });
	});

	test("choosing different themes per scheme leaves the selection unlinked", () => {
		const selection = m.selectSchemeTheme("dark", "night");
		expect(selection).toMatchObject({ linked: false, dark: "night", light: "catppuccin" });
	});

	test("relink moves both schemes to the family of the variant in effect", () => {
		m.setThemeMode("dark");
		m.selectSchemeTheme("dark", "pair");
		m.selectSchemeTheme("light", "day");
		expect(m.setThemeLinked(true)).toEqual({
			mode: "dark",
			linked: true,
			light: "pair",
			dark: "pair",
		});
	});

	test("relink falls back to the default when the effective theme has one variant", () => {
		m.setThemeMode("dark");
		m.selectSchemeTheme("dark", "night");
		expect(m.setThemeLinked(true)).toMatchObject({
			linked: true,
			light: "catppuccin",
			dark: "catppuccin",
		});
	});
});

describe("themes payload", () => {
	test("installs one style element as the last child of head and replaces it on reload", () => {
		m.applyThemesPayload(PAYLOAD);
		const first = headChildren.find((el) => el.id === "omp-themes");
		expect(first?.textContent).toContain('[data-theme-variant="pair/dark"]');
		headChildren.push({ id: "later", textContent: "" });
		m.applyThemesPayload({ ...PAYLOAD, themes: [theme("only")] });
		expect(headChildren.filter((el) => el.id === "omp-themes")).toHaveLength(1);
		expect(headChildren.at(-1)).toBe(first!);
		expect(first!.textContent).toContain('[data-theme-variant="only/dark"]');
		expect(first!.textContent).not.toContain("pair/dark");
	});

	test("a missing selected theme renders the default but keeps the stored id", () => {
		storage.set("omp-web:theme-mode", "dark");
		storage.set("omp-web:theme-dark", "gone");
		m.initTheme();
		expect(root.dataset.themeVariant).toBe("gone/dark");
		m.applyThemesPayload(PAYLOAD);
		expect(root.dataset.themeVariant).toBe("catppuccin/dark");
		expect(m.currentThemeSelection().dark).toBe("gone");
		expect(m.unavailableSchemes(PAYLOAD, m.currentThemeSelection())).toEqual(["dark"]);
	});

	test("a theme lacking the scheme's variant is unavailable for that scheme only", () => {
		storage.set("omp-web:theme-light", "night");
		expect(m.unavailableSchemes(PAYLOAD, m.currentThemeSelection())).toEqual(["light"]);
		expect(m.unavailableSchemes(null, m.currentThemeSelection())).toEqual([]);
	});

	test("caches the selected variants' CSS and the applied background for first paint", () => {
		m.setThemeMode("light");
		m.selectSchemeTheme("light", "pair");
		m.applyThemesPayload(PAYLOAD);
		const css = storage.get("omp-web:theme-css") ?? "";
		expect(css).toContain('[data-theme-variant="pair/light"]');
		expect(css).toContain('[data-theme-variant="catppuccin/dark"]');
		expect(css).not.toContain("night/dark");
		expect(storage.get("omp-web:theme-bg")).toBe(CORE.light.bg);
		m.setThemeMode("dark");
		expect(storage.get("omp-web:theme-bg")).toBe(CORE.dark.bg);
	});
});
