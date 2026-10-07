import { afterEach, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import { SETTING_TABS } from "@oh-my-pi/pi-tui/overlays/settings-defs";
import {
	buildSettingsModel,
	coerceSettingValue,
	settingChanged,
	type SettingsSession,
} from "#lib/sdk-settings/settings-model";

// The module reads/writes the shared Settings singleton (values, changed
// flags, condition gates). Initialize it in-memory so tests touch no disk.
await Settings.init({ inMemory: true });

afterEach(() => {
	for (const path of [
		"compaction.thresholdPercent",
		"compaction.thresholdTokens",
		"compaction.methodOrder",
		"providers.maxInFlightRequests",
		"memory.backend",
		"hindsight.apiToken",
	]) {
		lookup(path)!.unset(Settings.instance);
	}
});

const fakeSession: SettingsSession = {
	getAvailableThinkingLevels: () => ["low", "high"],
	getAvailableModels: () => [
		{ provider: "openai" },
		{ provider: "anthropic" },
		{ provider: "openai" },
	],
};

function itemsOf(tabId: string, model: ReturnType<typeof buildSettingsModel>) {
	return model.tabs.find((tab) => tab.id === tabId)!.groups.flatMap((group) => group.items);
}

describe("coerceSettingValue", () => {
	test("number settings accept numeric strings and 'default'", () => {
		expect(coerceSettingValue("compaction.thresholdPercent", "50")).toBe(50);
		expect(coerceSettingValue("compaction.thresholdPercent", 50)).toBe(50);
		expect(coerceSettingValue("compaction.thresholdPercent", "default")).toBe(-1);
		expect(coerceSettingValue("compaction.thresholdTokens", "default")).toBe(-1);
	});

	test("number settings reject non-finite values before persist", () => {
		// Regression: Number("abc")/Number("NaN")/Number("Infinity") used to
		// slip through, and JSON.stringify(NaN) → null corrupted settings.json.
		for (const bad of ["abc", "NaN", "Infinity"]) {
			expect(() => coerceSettingValue("compaction.thresholdPercent", bad)).toThrow(
				"Invalid numeric value for compaction.thresholdPercent",
			);
		}
	});

	test("record settings parse JSON strings and pass objects through", () => {
		expect(coerceSettingValue("providers.maxInFlightRequests", '{"openai": 4}')).toEqual({
			openai: 4,
		});
		expect(
			coerceSettingValue("providers.maxInFlightRequests", { openai: 2, anthropic: 1 }),
		).toEqual({
			openai: 2,
			anthropic: 1,
		});
	});

	test("record settings reject non-object JSON", () => {
		expect(() => coerceSettingValue("providers.maxInFlightRequests", "not json")).toThrow(
			"Invalid record JSON for providers.maxInFlightRequests",
		);
		expect(() => coerceSettingValue("providers.maxInFlightRequests", "[1]")).toThrow(
			"Invalid record JSON for providers.maxInFlightRequests",
		);
	});

	test("maxInFlightRequests values are validated", () => {
		expect(coerceSettingValue("providers.maxInFlightRequests", '{"openai": 4.7}')).toEqual({
			openai: 4,
		});
		expect(() => coerceSettingValue("providers.maxInFlightRequests", '{"openai": "4"}')).toThrow(
			"Provider request limits must be positive numbers",
		);
		expect(coerceSettingValue("providers.maxInFlightRequests", { openai: 0.2 })).toEqual({
			openai: 1,
		});
		for (const invalid of [0, -1, NaN, Infinity, null, true]) {
			expect(() =>
				coerceSettingValue("providers.maxInFlightRequests", { openai: invalid }),
			).toThrow("Provider request limits must be positive numbers: openai");
		}
	});

	test("boolean settings accept booleans and 'true'/'false' strings", () => {
		expect(coerceSettingValue("advisor.enabled", true)).toBe(true);
		expect(coerceSettingValue("advisor.enabled", "true")).toBe(true);
		expect(coerceSettingValue("advisor.enabled", false)).toBe(false);
		expect(coerceSettingValue("advisor.enabled", "false")).toBe(false);
	});

	test("string settings stringify their input", () => {
		expect(coerceSettingValue("theme.dark", "titanium")).toBe("titanium");
		expect(coerceSettingValue("theme.dark", 123)).toBe("123");
	});

	test("unset optional/credential strings (undefined current) store raw input", () => {
		// hindsight.apiToken is a credential string defaulting to undefined;
		// the TUI's fallback stores the raw input; must not throw.
		lookup("hindsight.apiToken")!.unset(Settings.instance);
		expect(coerceSettingValue("hindsight.apiToken", "s3cret")).toBe("s3cret");
	});

	test("multiselect settings filter to string arrays", () => {
		expect(coerceSettingValue("compaction.methodOrder", ["server", 7, "soft"])).toEqual([
			"server",
			"soft",
		]);
		expect(coerceSettingValue("compaction.methodOrder", "not-an-array")).toEqual([]);
	});

	test("unknown paths throw", () => {
		expect(() => coerceSettingValue("no.such.path", 1)).toThrow("Unknown setting: no.such.path");
		for (const retired of [
			"providers.webSearchOrder",
			"providers.webSearchExclude",
			"providers.imageOrder",
		]) {
			expect(() => coerceSettingValue(retired, [])).toThrow(`Unknown setting: ${retired}`);
		}
	});
});

describe("settingChanged", () => {
	test("scalar values compare with Object.is", () => {
		expect(settingChanged(5, 5)).toBe(false);
		expect(settingChanged(5, 6)).toBe(true);
		expect(settingChanged("auto", "auto")).toBe(false);
		expect(settingChanged(undefined, undefined)).toBe(false);
		expect(settingChanged(true, "true")).toBe(true);
	});

	test("arrays compare by length and elementwise equality", () => {
		expect(settingChanged(["a", "b"], ["a", "b"])).toBe(false);
		expect(settingChanged(["a", "b"], ["a", "c"])).toBe(true);
		expect(settingChanged(["a"], ["a", "b"])).toBe(true);
		expect(settingChanged([], [])).toBe(false);
	});

	test("nested arrays compare elementwise (shallow, by reference)", () => {
		// Elementwise === on references: freshly-built nested arrays always differ.
		expect(settingChanged([[1], [2]], [[1], [2]])).toBe(true);
		expect(settingChanged([["a"], ["b"]], [["a"], ["b"]])).toBe(true);
		// The same reference is not changed.
		const shared: unknown[][] = [[1], [2]];
		expect(settingChanged(shared, shared)).toBe(false);
	});
});

describe("buildSettingsModel", () => {
	test("builds every schema tab with labeled, populated groups", () => {
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		expect(model.tabs.map((tab) => tab.id)).toEqual(SETTING_TABS);
		for (const tab of model.tabs) {
			expect(tab.label.length).toBeGreaterThan(0);
			expect(tab.groups.length).toBeGreaterThan(0);
			for (const group of tab.groups) {
				expect(group.items.length).toBeGreaterThan(0);
				for (const item of group.items) {
					expect(typeof item.label).toBe("string");
					expect(typeof item.description).toBe("string");
					expect(typeof item.changed).toBe("boolean");
					expect(item.path).toBeTruthy();
				}
			}
		}
	});

	test("theme.dark carries the available themes as options", () => {
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const themeDark = itemsOf("appearance", model).find((item) => item.path === "theme.dark");
		expect(themeDark?.type).toBe("submenu");
		expect(themeDark?.options).toEqual([
			{ value: "dark", label: "dark" },
			{ value: "light", label: "light" },
		]);
	});

	test("defaultThinkingLevel prepends auto and merges session levels", () => {
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const item = itemsOf("model", model).find((item) => item.path === "defaultThinkingLevel");
		expect(item?.type).toBe("submenu");
		expect(item?.options?.[0]).toEqual({ value: "auto", label: "auto" });
		const values = item!.options!.map((option) => option.value);
		expect(values).toContain("low");
		expect(values).toContain("high");
	});

	test("providerLimits providers are sorted and de-duplicated", () => {
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const item = itemsOf("providers", model).find((item) => item.type === "providerLimits");
		expect(item?.providers).toEqual(["anthropic", "openai"]);
	});

	test("changed flags reflect the live settings singleton", () => {
		lookup("compaction.thresholdPercent")!.set(Settings.instance, 80);
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const item = itemsOf("context", model).find(
			(item) => item.path === "compaction.thresholdPercent",
		);
		expect(item?.value).toBe(80);
		expect(item?.changed).toBe(true);
		lookup("compaction.thresholdPercent")!.set(Settings.instance, -1);
	});

	test("compaction threshold resets clear changed flags after persistence", () => {
		for (const path of ["compaction.thresholdPercent", "compaction.thresholdTokens"]) {
			const setting = lookup(path)!;
			setting.set(Settings.instance, coerceSettingValue(path, "50"));
			expect(
				itemsOf("context", buildSettingsModel(fakeSession, [])).find((item) => item.path === path),
			).toMatchObject({ value: 50, changed: true });
			setting.set(Settings.instance, coerceSettingValue(path, "default"));
			expect(
				itemsOf("context", buildSettingsModel(fakeSession, [])).find((item) => item.path === path),
			).toMatchObject({ value: -1, changed: false });
		}
	});

	test("ordered compaction choices reflect the saved order", () => {
		lookup("compaction.methodOrder")!.set(
			Settings.instance,
			coerceSettingValue("compaction.methodOrder", ["soft", "server"]),
		);
		const item = itemsOf("context", buildSettingsModel(fakeSession, [])).find(
			(item) => item.path === "compaction.methodOrder",
		);
		expect(item).toMatchObject({
			type: "multiselect",
			ordered: true,
			value: ["soft", "server"],
			changed: true,
		});
	});

	test("provider limits retain configured providers absent from available models", () => {
		lookup("providers.maxInFlightRequests")!.set(
			Settings.instance,
			coerceSettingValue("providers.maxInFlightRequests", { unavailable: 3.9 }),
		);
		const item = itemsOf("providers", buildSettingsModel(fakeSession, [])).find(
			(item) => item.type === "providerLimits",
		);
		expect(item?.value).toEqual({ unavailable: 3 });
		expect(item?.providers).toEqual(["anthropic", "openai", "unavailable"]);
	});

	test("environment credentials never populate the editable settings model", () => {
		const previous = process.env.HINDSIGHT_API_TOKEN;
		process.env.HINDSIGHT_API_TOKEN = "environment-secret";
		try {
			lookup("memory.backend")!.set(Settings.instance, "hindsight");
			lookup("hindsight.apiToken")!.unset(Settings.instance);
			const item = itemsOf("memory", buildSettingsModel(fakeSession, [])).find(
				(entry) => entry.path === "hindsight.apiToken",
			);
			expect(item).toMatchObject({ type: "text", secret: true, changed: false });
			expect(item?.value).toBeUndefined();
			lookup("hindsight.apiToken")!.set(
				Settings.instance,
				coerceSettingValue("hindsight.apiToken", "configured-secret"),
			);
			const saved = itemsOf("memory", buildSettingsModel(fakeSession, [])).find(
				(entry) => entry.path === "hindsight.apiToken",
			);
			expect(saved?.value).toBe("configured-secret");
		} finally {
			if (previous === undefined) delete process.env.HINDSIGHT_API_TOKEN;
			else process.env.HINDSIGHT_API_TOKEN = previous;
		}
	});

	test("condition-gated defs respond to live settings on every build", () => {
		lookup("memory.backend")!.set(Settings.instance, "hindsight");
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const hindsightItems = itemsOf("memory", model).filter((item) =>
			item.path.startsWith("hindsight."),
		);
		expect(hindsightItems.length).toBeGreaterThan(0);
		lookup("memory.backend")!.unset(Settings.instance);
	});
});
