import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { parseThemeFile } from "#lib/themes/parse";
import type { ThemesPayload } from "#lib/themes/types";
import {
	changeThemeLinked,
	changeThemeMode,
	chooseLinkedTheme,
	chooseSchemeTheme,
	reloadThemes,
	setState,
	state,
} from "../../state";

/** Process-global stubs for the browser APIs the theme store touches; restored in afterAll. */
const installed: Array<{ key: string; original: PropertyDescriptor | undefined }> = [];
function installGlobal(key: string, value: unknown): void {
	installed.push({ key, original: Object.getOwnPropertyDescriptor(globalThis, key) });
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const storage = new Map<string, string>();
let root: { dataset: Record<string, string>; style: Record<string, string> };
let reply: () => { status: number; body: unknown };
let requests: string[] = [];

beforeAll(() => {
	installGlobal("localStorage", {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
		removeItem: (k: string) => void storage.delete(k),
	});
	installGlobal("window", {
		matchMedia: () => ({ matches: false, addEventListener: () => {} }),
	});
	installGlobal("fetch", async (input: unknown) => {
		requests.push(String(input));
		const { status, body } = reply();
		return {
			ok: status >= 200 && status < 300,
			status,
			json: async () => body,
			text: async () => JSON.stringify(body),
		} as unknown as Response;
	});
});

beforeEach(() => {
	storage.clear();
	requests = [];
	root = { dataset: {}, style: {} };
	const head: Array<{ id: string; textContent: string }> = [];
	installGlobal("document", {
		documentElement: root,
		head: { append: (el: { id: string; textContent: string }) => void head.push(el) },
		createElement: () => ({ id: "", textContent: "" }),
		getElementById: (id: string) => head.find((el) => el.id === id) ?? null,
	});
	setState({ authStatus: "disabled", themes: null, themesError: null, themesLoading: false });
});

afterEach(() => {
	setState({ themes: null, themesError: null, themesLoading: false });
});

afterAll(() => {
	for (const { key, original } of installed.reverse()) {
		if (original === undefined) Reflect.deleteProperty(globalThis, key);
		else Object.defineProperty(globalThis, key, original);
	}
});

function payloadOf(...ids: string[]): ThemesPayload {
	const colors = {
		bg: "#1e1e2e",
		panel: "#313244",
		text: "#cdd6f4",
		muted: "#a6adc8",
		border: "#45475a",
		accent: "#89b4fa",
		success: "#a6e3a1",
		warning: "#f9e2af",
		error: "#f38ba8",
	};
	const themes = ids.map((id) => {
		const result = parseThemeFile(
			id,
			{ schemaVersion: 1, name: id, variants: { dark: colors, light: colors } },
			"custom",
		);
		if (!result.ok) throw new Error(result.errors.join("; "));
		return result.entry;
	});
	return { dir: "/themes", themes, failures: [] };
}

describe("theme store", () => {
	test("reloadThemes GETs /ctl/themes and mirrors the payload", async () => {
		const payload = payloadOf("catppuccin", "mine");
		reply = () => ({ status: 200, body: payload });
		await reloadThemes();
		expect(requests).toEqual(["/ctl/themes"]);
		expect(state.themes?.themes.map((t) => t.id)).toEqual(["catppuccin", "mine"]);
		expect(state.themesError).toBeNull();
		expect(state.themesLoading).toBe(false);
	});

	test("concurrent reloads share one request", async () => {
		reply = () => ({ status: 200, body: payloadOf("catppuccin") });
		await Promise.all([reloadThemes(), reloadThemes()]);
		expect(requests).toHaveLength(1);
	});

	test("a failed reload sets the error and keeps the previous payload and its selection rendering", async () => {
		reply = () => ({ status: 200, body: payloadOf("catppuccin", "mine") });
		await reloadThemes();
		chooseLinkedTheme("mine");
		expect(root.dataset.themeVariant).toBe("mine/dark");

		reply = () => ({ status: 500, body: { error: "boom" } });
		await reloadThemes();
		expect(state.themesError).toContain("boom");
		expect(state.themes?.themes.map((t) => t.id)).toEqual(["catppuccin", "mine"]);
		expect(root.dataset.themeVariant).toBe("mine/dark");

		reply = () => ({ status: 200, body: payloadOf("catppuccin") });
		await reloadThemes();
		expect(state.themesError).toBeNull();
		expect(root.dataset.themeVariant).toBe("catppuccin/dark");
		expect(state.themeSelection.dark).toBe("mine");
	});

	test("actions keep the reactive selection mirror in step with storage", async () => {
		reply = () => ({ status: 200, body: payloadOf("catppuccin", "mine") });
		await reloadThemes();
		changeThemeMode("light");
		expect(state.themeSelection.mode).toBe("light");
		chooseSchemeTheme("dark", "mine");
		expect(state.themeSelection).toMatchObject({
			linked: false,
			dark: "mine",
			light: "catppuccin",
		});
		changeThemeLinked(true);
		expect(state.themeSelection).toMatchObject({
			linked: true,
			dark: "catppuccin",
			light: "catppuccin",
		});
	});
});
