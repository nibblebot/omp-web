import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { currentThemePreference, initTheme, setTheme } from "../../prefs/theme";

type MediaListener = (e: { matches: boolean }) => void;

/** Process-global stubs for the browser APIs theme.ts touches; restored in afterAll. */
const installed: Array<{ key: string; original: PropertyDescriptor | undefined }> = [];
function installGlobal(key: string, value: unknown): void {
	installed.push({ key, original: Object.getOwnPropertyDescriptor(globalThis, key) });
	Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}

const storage = new Map<string, string>();
let osPrefersLight = false;
let mediaListeners: MediaListener[] = [];
let root: { dataset: Record<string, string>; style: Record<string, string> };

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

beforeEach(() => {
	storage.clear();
	mediaListeners = [];
	osPrefersLight = false;
	root = { dataset: {}, style: {} };
	installGlobal("document", { documentElement: root });
});

afterAll(() => {
	for (const { key, original } of installed.reverse()) {
		if (original === undefined) Reflect.deleteProperty(globalThis, key);
		else Object.defineProperty(globalThis, key, original);
	}
});

describe("system theme resolution", () => {
	test("system with an OS light preference resolves to catppuccin-latte", () => {
		osPrefersLight = true;
		setTheme("system");
		expect(root.dataset.theme).toBe("catppuccin-latte");
	});

	test("system with an OS dark preference resolves to dark", () => {
		osPrefersLight = false;
		setTheme("system");
		expect(root.dataset.theme).toBe("dark");
	});

	test("unset preference (null) defaults to system and resolves to catppuccin-latte under OS light", () => {
		osPrefersLight = true;
		initTheme();
		expect(currentThemePreference()).toBe("system");
		expect(root.dataset.theme).toBe("catppuccin-latte");
	});

	test("initTheme resolves system through the OS light preference", () => {
		storage.set("omp-web:theme", "system");
		osPrefersLight = true;
		initTheme();
		expect(root.dataset.theme).toBe("catppuccin-latte");
	});

	test("OS-change listener follows light to latte and back to dark while on system", () => {
		storage.set("omp-web:theme", "system");
		initTheme();
		expect(root.dataset.theme).toBe("dark");

		setOsPreference(true);
		expect(root.dataset.theme).toBe("catppuccin-latte");

		setOsPreference(false);
		expect(root.dataset.theme).toBe("dark");
	});

	test("OS-change listener ignores the OS when an explicit theme is chosen", () => {
		setTheme("omp-dark");
		initTheme();
		setOsPreference(true);
		expect(root.dataset.theme).toBe("omp-dark");
	});
});

describe("explicit themes", () => {
	test("explicit light stays light, even with an OS light preference", () => {
		osPrefersLight = true;
		setTheme("light");
		expect(currentThemePreference()).toBe("light");
		expect(root.dataset.theme).toBe("light");
	});

	test("explicit light stays light, even with an OS dark preference", () => {
		osPrefersLight = false;
		setTheme("light");
		expect(root.dataset.theme).toBe("light");
	});

	test("explicit light is not switched by an OS-change event", () => {
		setTheme("light");
		initTheme();
		setOsPreference(false);
		expect(root.dataset.theme).toBe("light");
	});

	test("explicit dark stays dark under an OS light preference", () => {
		osPrefersLight = true;
		setTheme("dark");
		expect(root.dataset.theme).toBe("dark");
	});

	test("explicit catppuccin-latte is applied directly", () => {
		osPrefersLight = false;
		setTheme("catppuccin-latte");
		expect(root.dataset.theme).toBe("catppuccin-latte");
	});
});
