import { describe, expect, test } from "bun:test";
import { groupModelRoles } from "./model-roles";

const MODEL_ROLES = [
	{ role: "default", provider: "anthropic", id: "claude-sonnet" },
	{ role: "smol", provider: "anthropic", id: "claude-haiku" },
	{ role: "slow", provider: "anthropic", id: "claude-sonnet" },
	{ role: "vision", provider: "openai", id: "gpt-4o" },
];

describe("groupModelRoles", () => {
	test("groups by model and preserves first-seen order", () => {
		expect(groupModelRoles(MODEL_ROLES, undefined)).toEqual([
			{ provider: "anthropic", id: "claude-sonnet", roles: ["default", "slow"] },
			{ provider: "anthropic", id: "claude-haiku", roles: ["smol"] },
			{ provider: "openai", id: "gpt-4o", roles: ["vision"] },
		]);
	});

	test("stacks multiple roles for the same model", () => {
		const groups = groupModelRoles(MODEL_ROLES, undefined);
		expect(groups).toHaveLength(3);
		expect(groups[0].roles).toEqual(["default", "slow"]);
	});

	test("empty and undefined input yield []", () => {
		expect(groupModelRoles(undefined, undefined)).toEqual([]);
		expect(groupModelRoles([], undefined)).toEqual([]);
	});
});
