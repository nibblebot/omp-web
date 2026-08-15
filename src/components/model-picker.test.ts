import { describe, expect, test } from "bun:test";
import { thinkingLevelLabel, thinkingOptions } from "./ModelPicker";

describe("thinkingLevelLabel (TUI label parity)", () => {
	test("minimal renders as min; other levels are their wire value", () => {
		expect(thinkingLevelLabel("minimal")).toBe("min");
		expect(thinkingLevelLabel("low")).toBe("low");
		expect(thinkingLevelLabel("xhigh")).toBe("xhigh");
		expect(thinkingLevelLabel("max")).toBe("max");
	});
});

describe("thinkingOptions (ModelPicker step 3)", () => {
	test("no controllable effort surface yields no options — caller skips the thinking step", () => {
		expect(thinkingOptions(undefined)).toEqual([]);
		expect(thinkingOptions([])).toEqual([]);
	});

	test("a surface surfaces inherit + off + the model's ladder in catalog order, TUI labels", () => {
		expect(thinkingOptions(["minimal", "low", "medium", "high", "xhigh", "max"])).toEqual([
			{ value: "inherit", label: "inherit", hint: "Inherit session default" },
			{ value: "off", label: "off", hint: "No reasoning" },
			{ value: "minimal", label: "min" },
			{ value: "low", label: "low" },
			{ value: "medium", label: "medium" },
			{ value: "high", label: "high" },
			{ value: "xhigh", label: "xhigh" },
			{ value: "max", label: "max" },
		]);
	});

	test("a partial ladder is preserved verbatim (e.g. ollama high/max)", () => {
		expect(thinkingOptions(["high", "max"])).toEqual([
			{ value: "inherit", label: "inherit", hint: "Inherit session default" },
			{ value: "off", label: "off", hint: "No reasoning" },
			{ value: "high", label: "high" },
			{ value: "max", label: "max" },
		]);
	});
});
