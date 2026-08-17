import { beforeEach, describe, expect, test } from "bun:test";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModelRoleCatalog } from "./daemon-broker";

// The catalog builder reads/writes the shared Settings singleton (role
// values, sources, tags). Initialize it in-memory so tests touch no disk.
await Settings.init({ inMemory: true });

// Minimal structural stubs — the SDK matcher only reads provider/id (+ name).
const STUB_MODELS = [
	{ provider: "openai", id: "gpt-4o" },
	{ provider: "anthropic", id: "claude-3-5-sonnet" },
	{ provider: "openai", id: "o3-mini" },
] as unknown as Model[];

beforeEach(() => {
	// Reset the layers the builder reads: global roles/tags wholesale, plus
	// any project-layer roles installed by the source-mapping test.
	settings.set("modelRoles", {});
	settings.set("modelTags", {});
	for (const role of ["smol", "slow", "vision", "writer", "default"]) {
		settings.clearProjectModelRole(role);
	}
});

function catalog(options: { models?: Model[]; current?: Model } = {}) {
	return buildModelRoleCatalog({
		settings,
		availableModels: options.models ?? STUB_MODELS,
		currentModel: options.current,
	});
}

describe("buildModelRoleCatalog", () => {
	test("lists built-in roles in canonical order, then custom roles", () => {
		settings.setModelRole("writer", "openai/gpt-4o");
		const roles = catalog()!.map((entry) => entry.role);
		expect(roles).toEqual([...MODEL_ROLE_IDS, "writer"]);
	});

	test("carries the TUI tag for built-ins; custom roles fall back to name only", () => {
		settings.setModelRole("writer", "openai/gpt-4o");
		const entries = catalog()!;
		expect(entries.find((entry) => entry.role === "smol")).toMatchObject({
			tag: "SMOL",
			name: "Fast",
		});
		expect(entries.find((entry) => entry.role === "plan")).toMatchObject({
			tag: "PLAN",
			name: "Architect",
		});
		expect(entries.find((entry) => entry.role === "writer")).not.toHaveProperty("tag");
	});

	test("surfaces the hidden flag from modelTags", () => {
		settings.set("modelTags", { smol: { name: "Fast", hidden: true } });
		const entries = catalog()!;
		expect(entries.find((entry) => entry.role === "smol")).toMatchObject({
			name: "Fast",
			hidden: true,
		});
		expect(entries.find((entry) => entry.role === "slow")).toMatchObject({ hidden: false });
	});

	test("keeps hidden custom roles in the catalog with their flag", () => {
		settings.setModelRole("writer", "openai/gpt-4o");
		settings.set("modelTags", { writer: { name: "Writer", hidden: true } });
		expect(catalog()!.find((entry) => entry.role === "writer")).toMatchObject({
			role: "writer",
			name: "Writer",
			hidden: true,
			provider: "openai",
			id: "gpt-4o",
		});
	});

	test("surfaces thinkingLevel only when baked into the role value", () => {
		settings.setModelRole("smol", "anthropic/claude-3-5-sonnet:high");
		settings.setModelRole("slow", "openai/gpt-4o");
		// The `:auto` sentinel cannot round-trip through role values.
		settings.setModelRole("vision", "anthropic/claude-3-5-sonnet:auto");
		const entries = catalog()!;
		expect(entries.find((entry) => entry.role === "smol")).toMatchObject({
			provider: "anthropic",
			id: "claude-3-5-sonnet",
			thinkingLevel: "high",
		});
		expect(entries.find((entry) => entry.role === "slow")).not.toHaveProperty("thinkingLevel");
		expect(entries.find((entry) => entry.role === "vision")).toMatchObject({
			provider: "anthropic",
			id: "claude-3-5-sonnet",
		});
		expect(entries.find((entry) => entry.role === "vision")).not.toHaveProperty("thinkingLevel");
	});

	test("maps source to the persisted layer owning the assignment", () => {
		settings.setModelRole("smol", "openai/gpt-4o");
		settings.setProjectModelRole("writer", "openai/gpt-4o");
		const entries = catalog()!;
		expect(entries.find((entry) => entry.role === "smol")?.source).toBe("global");
		expect(entries.find((entry) => entry.role === "writer")?.source).toBe("project");
		expect(entries.find((entry) => entry.role === "slow")?.source).toBe("default");
	});

	test("returns undefined when no models are available", () => {
		expect(catalog({ models: [] })).toBeUndefined();
	});

	test("falls back to the current model for the default role when unassigned", () => {
		const entries = catalog({ current: STUB_MODELS[0] })!;
		expect(entries.find((entry) => entry.role === "default")).toMatchObject({
			role: "default",
			provider: "openai",
			id: "gpt-4o",
			source: "default",
		});
	});
});
