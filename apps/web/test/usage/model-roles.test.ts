import { describe, expect, test } from "bun:test";
import type { ModelPresetDetail, ModelRoleCatalogEntry } from "#lib/wire/protocol";
import {
	presetRoleRows,
	presetSegmentLabel,
	roleDisplay,
	roleLabel,
	splitRoleValue,
} from "../../usage/model-roles";

const catalog: ModelRoleCatalogEntry[] = [
	{
		role: "default",
		name: "Default",
		hidden: false,
		provider: "anthropic",
		id: "claude-opus-4-1",
		thinkingLevel: "high",
		value: "anthropic/claude-opus-4-1:high",
		source: "global",
	},
	{
		role: "smol",
		name: "Smol",
		tag: "SMOL",
		hidden: false,
		provider: "anthropic",
		id: "claude-haiku-5-5",
		value: "anthropic/claude-haiku-5-5",
		source: "global",
	},
	{ role: "slow", name: "Slow", hidden: false, source: "default" },
	// Configured, but the model is not available: the catalog resolves no provider/id.
	{ role: "web", name: "Web search", hidden: false, value: "web/exa", source: "global" },
];

const preset = (modelRoles: Record<string, string>): ModelPresetDetail => ({
	name: "fast",
	source: "global",
	modelRoles,
});

describe("splitRoleValue", () => {
	test("splits a known thinking level off the end", () => {
		expect(splitRoleValue("anthropic/claude-opus-4-1:high")).toEqual({
			model: "anthropic/claude-opus-4-1",
			level: "high",
		});
	});

	test("keeps a colon that is part of the model id", () => {
		expect(splitRoleValue("openrouter/qwen:free")).toEqual({ model: "openrouter/qwen:free" });
		expect(splitRoleValue("openrouter/qwen:free:low")).toEqual({
			model: "openrouter/qwen:free",
			level: "low",
		});
	});
});

describe("presetRoleRows", () => {
	const roles = {
		smol: "anthropic/claude-haiku-5-5",
		default: "anthropic/claude-opus-4-1:high",
		slow: "openai/gpt-5.2",
		zeta: "openai/gpt-5.2:low",
	};

	test("lists catalog roles in catalog order, then unknown roles by name", () => {
		const rows = presetRoleRows(preset(roles), catalog, false);
		expect(rows.map((r) => r.role)).toEqual(["default", "smol", "slow", "zeta"]);
		expect(rows[1]).toMatchObject({ label: "SMOL" });
		expect(rows[3]).toMatchObject({ label: "zeta", model: "openai/gpt-5.2", level: "low" });
	});

	test("compares against the configured value even when its model is unavailable", () => {
		const rows = presetRoleRows(preset({ web: "web/exa" }), catalog, true);
		expect(rows[0].current).toBeUndefined();
		const changed = presetRoleRows(preset({ web: "web/brave" }), catalog, true);
		expect(changed[0].current).toBe("web/exa");
	});

	test("marks only the rows that differ from the live roles", () => {
		const rows = presetRoleRows(preset(roles), catalog, true);
		expect(rows.find((r) => r.role === "default")?.current).toBeUndefined();
		expect(rows.find((r) => r.role === "smol")?.current).toBeUndefined();
		expect(rows.find((r) => r.role === "slow")?.current).toBe("unassigned");
	});

	test("shows the live thinking level when only the level differs", () => {
		const rows = presetRoleRows(
			preset({ default: "anthropic/claude-opus-4-1:low" }),
			catalog,
			true,
		);
		expect(rows[0].current).toBe("anthropic/claude-opus-4-1:high");
	});

	test("marks nothing for the active preset", () => {
		const rows = presetRoleRows(preset(roles), catalog, false);
		expect(rows.every((r) => r.current === undefined)).toBe(true);
	});
});

describe("roleLabel", () => {
	test("shows the tag, or the name for a role without one", () => {
		expect(roleLabel(catalog[1])).toBe("SMOL");
		expect(roleLabel(catalog[0])).toBe("Default");
	});
});

describe("roleDisplay", () => {
	test("shows the resolved model, an unavailable configured value, or nothing", () => {
		expect(roleDisplay(catalog[1])).toBe("anthropic/claude-haiku-5-5");
		expect(roleDisplay(catalog[3])).toBe("web/exa (unavailable)");
		expect(roleDisplay(catalog[2])).toBeUndefined();
	});
});

describe("presetSegmentLabel", () => {
	test("names the active preset, else custom when presets exist, else presets", () => {
		expect(presetSegmentLabel(undefined)).toBe("presets");
		expect(presetSegmentLabel({ names: [] })).toBe("presets");
		expect(presetSegmentLabel({ names: ["fast", "deep"] })).toBe("custom");
		expect(presetSegmentLabel({ names: ["fast", "deep"], active: "deep" })).toBe("deep");
	});
});
