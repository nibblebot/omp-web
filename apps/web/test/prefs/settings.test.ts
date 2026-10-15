import { describe, expect, test } from "bun:test";
import type { SettingsItem, SettingsModel, SettingsTab } from "#lib/wire/protocol";
import { displayOptionValue, filterSettings, formatItemValue } from "../../prefs/settings";

function item(partial: Partial<SettingsItem> & Pick<SettingsItem, "type">): SettingsItem {
	return {
		path: `test.${partial.type}`,
		label: `Test ${partial.type}`,
		description: "",
		value: null,
		changed: false,
		...partial,
	};
}

describe("displayOptionValue", () => {
	test("compaction thresholds map stored -1 to 'default'", () => {
		expect(
			displayOptionValue(item({ type: "submenu", path: "compaction.thresholdPercent" }), -1),
		).toBe("default");
		expect(
			displayOptionValue(item({ type: "submenu", path: "compaction.thresholdTokens" }), -1),
		).toBe("default");
	});

	test("other values pass through", () => {
		expect(
			displayOptionValue(item({ type: "submenu", path: "compaction.thresholdPercent" }), "50"),
		).toBe("50");
		expect(displayOptionValue(item({ type: "enum", path: "other.path" }), -1)).toBe("-1");
		expect(displayOptionValue(item({ type: "enum", path: "other.path" }), 0)).toBe("0");
	});

	test("null/undefined render as empty string", () => {
		expect(displayOptionValue(item({ type: "enum" }), null)).toBe("");
		expect(displayOptionValue(item({ type: "enum" }), undefined)).toBe("");
	});
});

describe("formatItemValue", () => {
	test("boolean renders true/false", () => {
		expect(formatItemValue(item({ type: "boolean", value: true }))).toBe("true");
		expect(formatItemValue(item({ type: "boolean", value: false }))).toBe("false");
	});

	test("enum shows the raw value", () => {
		expect(formatItemValue(item({ type: "enum", value: "50" }))).toBe("50");
	});

	test("submenu shows the option label, falling back to the value", () => {
		const submenu = item({
			type: "submenu",
			value: "a",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
		});
		expect(formatItemValue(submenu)).toBe("Alpha");
		expect(formatItemValue(item({ type: "submenu", value: "zzz" }))).toBe("zzz");
	});

	test("submenu compaction -1 resolves the 'default' option label", () => {
		const submenu = item({
			type: "submenu",
			path: "compaction.thresholdPercent",
			value: -1,
			options: [{ value: "default", label: "Default" }],
		});
		expect(formatItemValue(submenu)).toBe("Default");
	});

	test("text shows the value, or empty when unset", () => {
		expect(formatItemValue(item({ type: "text", value: "hello" }))).toBe("hello");
		expect(formatItemValue(item({ type: "text", value: null }))).toBe("");
		expect(formatItemValue(item({ type: "text", value: 42 }))).toBe("42");
	});

	test("secret text masks with dots", () => {
		expect(formatItemValue(item({ type: "text", secret: true, value: "hunter2" }))).toBe(
			"••••••••",
		);
		expect(formatItemValue(item({ type: "text", secret: true, value: "" }))).toBe("");
	});

	test("multiselect joins option labels", () => {
		const multi = item({
			type: "multiselect",
			value: ["a", "b"],
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
		});
		expect(formatItemValue(multi)).toBe("Alpha, Beta");
		expect(formatItemValue(item({ type: "multiselect", value: ["x"] }))).toBe("x");
	});

	test("multiselect empty renders none, or default when ordered", () => {
		expect(formatItemValue(item({ type: "multiselect", value: [] }))).toBe("none");
		expect(formatItemValue(item({ type: "multiselect", value: [], ordered: true }))).toBe(
			"default",
		);
	});

	test("ordered multiselect joins with an arrow", () => {
		const multi = item({
			type: "multiselect",
			ordered: true,
			value: ["a", "b"],
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
			],
		});
		expect(formatItemValue(multi)).toBe("Alpha → Beta");
	});

	test("providerLimits renders Unlimited when empty, sorted entries otherwise", () => {
		expect(formatItemValue(item({ type: "providerLimits", value: {} }))).toBe("Unlimited");
		expect(formatItemValue(item({ type: "providerLimits", value: null }))).toBe("Unlimited");
		expect(formatItemValue(item({ type: "providerLimits", value: { b: 1, a: 2 } }))).toBe(
			"a: 2, b: 1",
		);
	});
});

describe("filterSettings", () => {
	const tabGeneral: SettingsTab = {
		id: "general",
		label: "General",
		groups: [
			{
				name: "",
				items: [
					item({
						type: "boolean",
						path: "ui.showTimestamps",
						label: "Show timestamps",
						description: "show time",
					}),
				],
			},
			{
				name: "Advanced",
				items: [
					item({
						type: "enum",
						path: "compaction.thresholdPercent",
						label: "Compaction percent",
						description: "compact at",
					}),
				],
			},
		],
	};
	const tabAppearance: SettingsTab = {
		id: "appearance",
		label: "Appearance",
		groups: [
			{
				name: "",
				items: [
					item({
						type: "text",
						path: "theme.name",
						label: "Max Tokens",
						description: "cap output",
					}),
					item({ type: "enum", path: "images.blockImages", label: "Block images" }),
					item({
						type: "boolean",
						path: "images.autoResize",
						label: "Auto-resize pastes",
						description: "shrink oversized images",
					}),
				],
			},
		],
	};
	const model: SettingsModel = { tabs: [tabGeneral, tabAppearance] };

	test("matches item path across tabs", () => {
		const matches = filterSettings(model, "thresholdPercent");
		expect(matches).toHaveLength(1);
		expect(matches[0].tab.label).toBe("General");
		expect(matches[0].item.path).toBe("compaction.thresholdPercent");
	});

	test("searches every appearance item, not only the Images group", () => {
		const max = filterSettings(model, "MAX");
		expect(max).toHaveLength(1);
		expect(max[0].tab.id).toBe("appearance");
		expect(max[0].item.path).toBe("theme.name");
		expect(filterSettings(model, "cap output")[0].item.path).toBe("theme.name");
		expect(filterSettings(model, "block images")[0].item.path).toBe("images.blockImages");
	});

	test("returns every matching item in tab order so callers can group by tab", () => {
		const matches = filterSettings(model, "images");
		expect(matches.map((match) => match.item.path)).toEqual([
			"images.blockImages",
			"images.autoResize",
		]);
		expect(matches.every((match) => match.tab.id === "appearance")).toBe(true);
	});

	test("returns [] for no match and for empty/whitespace queries", () => {
		expect(filterSettings(model, "nope")).toEqual([]);
		expect(filterSettings(model, "")).toEqual([]);
		expect(filterSettings(model, "   ")).toEqual([]);
	});
});
