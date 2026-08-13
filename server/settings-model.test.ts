import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { SETTING_TABS } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import {
	applySettingSideEffects,
	buildSettingsModel,
	coerceSettingValue,
	settingChanged,
	type AgentSessionLike,
	type SettingsSession,
} from "./settings-model";

// The module reads/writes the shared Settings singleton (values, changed
// flags, condition gates). Initialize it in-memory so tests touch no disk.
await Settings.init({ inMemory: true });

const fakeSession: SettingsSession = {
	getAvailableThinkingLevels: () => ["low", "high"],
	getAvailableModels: () => [{ provider: "openai" }, { provider: "anthropic" }, { provider: "openai" }],
};

function itemsOf(tabId: string, model: ReturnType<typeof buildSettingsModel>) {
	return model.tabs
		.find(tab => tab.id === tabId)!
		.groups.flatMap(group => group.items);
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
		expect(coerceSettingValue("providers.maxInFlightRequests", '{"openai": 4}')).toEqual({ openai: 4 });
		expect(coerceSettingValue("providers.maxInFlightRequests", { openai: 2, anthropic: 1 })).toEqual({
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
		expect(coerceSettingValue("providers.maxInFlightRequests", '{"openai": 4.7}')).toEqual({ openai: 4 });
		expect(() => coerceSettingValue("providers.maxInFlightRequests", '{"openai": "4"}')).toThrow(
			"Provider request limits must be positive numbers",
		);
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
		// the TUI's fallback stores the raw input — must not throw.
		Settings.instance.set("hindsight.apiToken", undefined as never);
		expect(coerceSettingValue("hindsight.apiToken", "s3cret")).toBe("s3cret");
	});

	test("multiselect settings filter to string arrays", () => {
		expect(coerceSettingValue("providers.webSearchOrder", ["google", 7, "exa"])).toEqual(["google", "exa"]);
		expect(coerceSettingValue("providers.webSearchOrder", "not-an-array")).toEqual([]);
	});

	test("session-managed paths pass through unchanged", () => {
		expect(coerceSettingValue("autoCompact", true)).toBe(true);
		expect(coerceSettingValue("thinkingLevel", "high")).toBe("high");
	});

	test("unknown paths throw", () => {
		expect(() => coerceSettingValue("no.such.path", 1)).toThrow("Unknown setting: no.such.path");
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
		expect(model.tabs.map(tab => tab.id)).toEqual(SETTING_TABS);
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
		const themeDark = itemsOf("appearance", model).find(item => item.path === "theme.dark");
		expect(themeDark?.type).toBe("submenu");
		expect(themeDark?.options).toEqual([
			{ value: "dark", label: "dark" },
			{ value: "light", label: "light" },
		]);
	});

	test("defaultThinkingLevel prepends auto and merges session levels", () => {
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const item = itemsOf("model", model).find(item => item.path === "defaultThinkingLevel");
		expect(item?.type).toBe("submenu");
		expect(item?.options?.[0]).toEqual({ value: "auto", label: "auto" });
		const values = item!.options!.map(option => option.value);
		expect(values).toContain("low");
		expect(values).toContain("high");
	});

	test("providerLimits providers are sorted and de-duplicated", () => {
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const item = itemsOf("providers", model).find(item => item.type === "providerLimits");
		expect(item?.providers).toEqual(["anthropic", "openai"]);
	});

	test("changed flags reflect the live settings singleton", () => {
		Settings.instance.set("compaction.thresholdPercent", 80);
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const item = itemsOf("context", model).find(item => item.path === "compaction.thresholdPercent");
		expect(item?.value).toBe(80);
		expect(item?.changed).toBe(true);
		Settings.instance.set("compaction.thresholdPercent", -1);
	});

	test("condition-gated defs respond to live settings on every build", () => {
		Settings.instance.set("memory.backend", "hindsight");
		const model = buildSettingsModel(fakeSession, ["dark", "light"]);
		const hindsightItems = itemsOf("memory", model).filter(item => item.path.startsWith("hindsight."));
		expect(hindsightItems.length).toBeGreaterThan(0);
		Settings.instance.set("memory.backend", "off");
	});
});

describe("applySettingSideEffects", () => {
	test("applies session setters and runtime agent fields", async () => {
		const calls: string[] = [];
		const agent: AgentSessionLike["agent"] = {};
		const session: AgentSessionLike = {
			setSteeringMode: mode => void calls.push(`steering:${mode}`),
			setFollowUpMode: mode => void calls.push(`followUp:${mode}`),
			setInterruptMode: mode => void calls.push(`interrupt:${mode}`),
			setAdvisorEnabled: enabled => void calls.push(`advisor:${enabled}`),
			setThinkingLevel: (level, persist) => void calls.push(`thinking:${String(level)}:${persist === true}`),
			refreshBaseSystemPrompt: async () => void calls.push("refreshPrompt"),
			applyMemoryBackend: async () => void calls.push("applyMemory"),
			applyInspectImageModeChange: async () => void calls.push("applyInspectImage"),
			setAutoCompactionEnabled: enabled => void calls.push(`autoCompact:${enabled}`),
			agent,
		};

		await applySettingSideEffects(session, "steeringMode", "all");
		await applySettingSideEffects(session, "defaultThinkingLevel", "high");
		await applySettingSideEffects(session, "personality", "friendly");
		await applySettingSideEffects(session, "temperature", "1.5");
		await applySettingSideEffects(session, "omitThinking", true);
		await applySettingSideEffects(session, "autoCompact", true);
		await applySettingSideEffects(session, "memory.backend", "local");
		// Persist-only paths have no side effect.
		await applySettingSideEffects(session, "compaction.enabled", true);

		expect(calls).toEqual([
			"steering:all",
			"thinking:high:true",
			"refreshPrompt",
			"autoCompact:true",
			"applyMemory",
		]);
		expect(agent.temperature).toBe(1.5);
		expect(agent.hideThinkingSummary).toBe(true);

		await applySettingSideEffects(session, "temperature", -1);
		expect(agent.temperature).toBeUndefined();
	});
});
