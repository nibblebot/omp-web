import { describe, expect, test } from "bun:test";
import type { SettingsItem } from "#lib/wire/protocol";
import {
	applyProviderLimit,
	controlKind,
	hasWideSelection,
	moveSelected,
	numberUnit,
	numericOptionValue,
	optionStep,
	orderedRows,
	parseJsonDraft,
	parseNumberInput,
	reorderSelected,
	stepNumber,
	toggleSelected,
} from "../../prefs/setting-controls";

function item(type: SettingsItem["type"], extra: Partial<SettingsItem> = {}): SettingsItem {
	return {
		path: "a.b",
		label: "B",
		description: "",
		value: undefined,
		changed: false,
		...extra,
		type,
	};
}

describe("controlKind", () => {
	test("booleans are toggles", () => {
		expect(controlKind(item("boolean", { value: true }))).toBe("toggle");
	});

	test("short enums with two or three options are segmented", () => {
		expect(controlKind(item("enum", { values: ["off", "low", "high"] }))).toBe("segmented");
	});

	test("enums with long labels or more than three options are selects", () => {
		expect(controlKind(item("enum", { values: ["short", "a-very-long-label-value"] }))).toBe(
			"select",
		);
		expect(controlKind(item("enum", { values: ["a", "b", "c", "d"] }))).toBe("select");
	});

	test("numeric submenus step; other submenus are selects", () => {
		const numeric = [
			{ value: "default", label: "Default" },
			{ value: "1", label: "1" },
			{ value: "2", label: "2" },
		];
		expect(controlKind(item("submenu", { options: numeric }))).toBe("stepper");
		const named = [
			{ value: "auto", label: "Auto" },
			{ value: "1", label: "1" },
		];
		expect(controlKind(item("submenu", { options: named }))).toBe("select");
	});

	test("selects stack only when the selected label is too wide for the help text", () => {
		const options = [
			{ value: "any", label: "Any error" },
			{ value: "heart", label: "Heart (American female)" },
		];
		expect(hasWideSelection(item("submenu", { options, value: "any" }))).toBe(false);
		expect(hasWideSelection(item("submenu", { options, value: "heart" }))).toBe(true);
	});

	test("text rows pick secret, number, or text from the value", () => {
		expect(controlKind(item("text", { secret: true, value: "k" }))).toBe("secret");
		expect(controlKind(item("text", { value: 42 }))).toBe("number");
		expect(controlKind(item("text", { value: "https://x" }))).toBe("text");
	});

	test("multiselects are ordered lists; provider limits and lists/records are their own kinds", () => {
		expect(controlKind(item("multiselect", { ordered: true }))).toBe("orderedList");
		expect(controlKind(item("providerLimits", { providers: ["p"] }))).toBe("providerLimits");
		expect(controlKind(item("list", { value: [] }))).toBe("json");
		expect(controlKind(item("record", { value: {} }))).toBe("json");
	});
});

describe("numericOptionValue", () => {
	test("default is the -1 sentinel; numeric strings parse; the rest is undefined", () => {
		expect(numericOptionValue("default")).toBe(-1);
		expect(numericOptionValue("1.5")).toBe(1.5);
		expect(numericOptionValue("")).toBeUndefined();
		expect(numericOptionValue("auto")).toBeUndefined();
	});
});

describe("optionStep", () => {
	const options = [
		{ value: "1", label: "One" },
		{ value: "2", label: "Two" },
		{ value: "5", label: "Five" },
	];

	test("a matching value shows its label with neighbours on each side", () => {
		expect(optionStep(options, 2)).toEqual({
			text: "Two",
			previous: options[0],
			next: options[2],
		});
	});

	test("the ends have no neighbour", () => {
		expect(optionStep(options, 1).previous).toBeUndefined();
		expect(optionStep(options, 5).next).toBeUndefined();
	});

	test("a value between options shows its number and steps to the nearest option each way", () => {
		const step = optionStep(options, 3);
		expect(step.text).toBe("3");
		expect(step.previous).toEqual(options[1]);
		expect(step.next).toEqual(options[2]);
	});

	test("default (-1) matches the default option", () => {
		const withDefault = [{ value: "default", label: "Default" }, ...options];
		const step = optionStep(withDefault, -1);
		expect(step.text).toBe("Default");
		expect(step.previous).toBeUndefined();
		expect(step.next).toEqual(options[0]);
	});
});

describe("typed numbers", () => {
	test("the unit comes from the path suffix", () => {
		expect(numberUnit("mcp.startupTimeoutMs")).toBe("ms");
		expect(numberUnit("a.timeoutSec")).toBe("s");
		expect(numberUnit("a.waitMinutes")).toBe("min");
		expect(numberUnit("a.ttlHours")).toBe("h");
		expect(numberUnit("a.contextLines")).toBe("lines");
		expect(numberUnit("a.temperature")).toBeUndefined();
	});

	test("input parses numbers and rejects empty or non-finite text", () => {
		expect(parseNumberInput("12")).toBe(12);
		expect(parseNumberInput("0.5")).toBe(0.5);
		expect(parseNumberInput("")).toBeUndefined();
		expect(parseNumberInput("   ")).toBeUndefined();
		expect(parseNumberInput("abc")).toBeUndefined();
	});

	test("steps are whole numbers for small integers, tenths for fractions, and round decades for large integers", () => {
		expect(stepNumber(5, 1)).toBe(6);
		expect(stepNumber(3, -1)).toBe(2);
		expect(stepNumber(0.1, 1)).toBe(0.2);
		expect(stepNumber(0.3, -1)).toBe(0.2);
		expect(stepNumber(420000, 1)).toBe(430000);
		expect(stepNumber(420000, -1)).toBe(410000);
		expect(stepNumber(420001, -1)).toBe(420000);
		expect(stepNumber(420001, 1)).toBe(430000);
	});
});

describe("ordered list", () => {
	const options = [
		{ value: "a", label: "A" },
		{ value: "b", label: "B" },
		{ value: "c", label: "C" },
	];

	test("enabled entries come first in stored order, then the rest in declared order", () => {
		const rows = orderedRows(options, ["c", "a"]);
		expect(rows.map((r) => [r.option.value, r.rank])).toEqual([
			["c", 0],
			["a", 1],
			["b", undefined],
		]);
	});

	test("unknown stored values are dropped from the rows", () => {
		const rows = orderedRows(options, ["zzz", "b"]);
		expect(rows.map((r) => r.option.value)).toEqual(["b", "a", "c"]);
	});

	test("moving swaps with the neighbour and stops at the edges", () => {
		expect(moveSelected(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
		expect(moveSelected(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
		expect(moveSelected(["a", "b"], "a", -1)).toEqual(["a", "b"]);
		expect(moveSelected(["a", "b"], "z", 1)).toEqual(["a", "b"]);
	});

	test("reordering lands the entry before the given index", () => {
		expect(reorderSelected(["a", "b", "c"], "a", 2)).toEqual(["b", "a", "c"]);
		expect(reorderSelected(["a", "b", "c"], "c", 0)).toEqual(["c", "a", "b"]);
		expect(reorderSelected(["a", "b", "c"], "b", 3)).toEqual(["a", "c", "b"]);
		expect(reorderSelected(["a", "b", "c"], "b", 1)).toEqual(["a", "b", "c"]);
		expect(reorderSelected(["a", "b", "c"], "b", 2)).toEqual(["a", "b", "c"]);
		expect(reorderSelected(["a", "b"], "z", 0)).toEqual(["a", "b"]);
	});

	test("toggling appends when enabling and keeps the others' order when disabling", () => {
		expect(toggleSelected(["a", "b"], "c")).toEqual(["a", "b", "c"]);
		expect(toggleSelected(["a", "b", "c"], "a")).toEqual(["b", "c"]);
	});
});

describe("parseJsonDraft", () => {
	test("accepts an array for lists and an object for records", () => {
		expect(parseJsonDraft("[1,2]", "list")).toEqual({ ok: true, value: [1, 2] });
		expect(parseJsonDraft('{"a":1}', "record")).toEqual({ ok: true, value: { a: 1 } });
	});

	test("rejects the wrong shape and invalid JSON with a message", () => {
		expect(parseJsonDraft("{}", "list")).toEqual({ ok: false, error: "Expected a JSON list" });
		expect(parseJsonDraft("[]", "record")).toEqual({ ok: false, error: "Expected a JSON object" });
		expect(parseJsonDraft("null", "record")).toEqual({
			ok: false,
			error: "Expected a JSON object",
		});
		const bad = parseJsonDraft("nope", "list");
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error.startsWith("Invalid JSON")).toBe(true);
	});
});

describe("applyProviderLimit", () => {
	test("sets a numeric limit, keeps other providers, and keeps non-numeric text as typed", () => {
		expect(applyProviderLimit({ a: 1 }, "b", "3")).toEqual({ a: 1, b: 3 });
		expect(applyProviderLimit({}, "b", "x")).toEqual({ b: "x" });
	});

	test("an empty input removes that provider's limit", () => {
		expect(applyProviderLimit({ a: 1, b: 2 }, "b", "")).toEqual({ a: 1 });
	});
});
