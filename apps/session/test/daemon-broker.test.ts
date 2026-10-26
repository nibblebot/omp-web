import { beforeEach, describe, expect, test } from "bun:test";
import { Settings, settings } from "@oh-my-pi/pi-coding-agent";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { cfgModelRoles, cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModelRoleCatalog, createDaemonRosterGate, roleCatalogModels } from "../daemon-broker";
import type { DaemonInfo } from "#lib/wire/protocol";

// The catalog builder reads/writes the shared Settings singleton (role
// values, sources, tags). Initialize it in-memory so tests touch no disk.
await Settings.init({ inMemory: true });

// Minimal structural stubs; the SDK matcher only reads provider/id (+ name).
const STUB_MODELS = [
	{ provider: "openai", id: "gpt-4o" },
	{ provider: "anthropic", id: "claude-3-5-sonnet" },
	{ provider: "openai", id: "o3-mini" },
] as unknown as Model[];

beforeEach(() => {
	// Reset the layers the builder reads: global roles/tags wholesale, plus
	// any project-layer roles installed by the source-mapping test.
	cfgModelRoles.set(settings, {});
	cfgModelTags.set(settings, {});
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
		cfgModelTags.set(settings, { smol: { name: "Fast", hidden: true } });
		const entries = catalog()!;
		expect(entries.find((entry) => entry.role === "smol")).toMatchObject({
			name: "Fast",
			hidden: true,
		});
		expect(entries.find((entry) => entry.role === "slow")).toMatchObject({ hidden: false });
	});

	test("keeps hidden custom roles in the catalog with their flag", () => {
		settings.setModelRole("writer", "openai/gpt-4o");
		cfgModelTags.set(settings, { writer: { name: "Writer", hidden: true } });
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

	test("carries the configured value even when it resolves to no available model", () => {
		settings.setModelRole("smol", "anthropic/claude-3-5-sonnet:high");
		settings.setModelRole("slow", "web/exa");
		const entries = catalog({ current: STUB_MODELS[0] })!;
		expect(entries.find((entry) => entry.role === "smol")?.value).toBe(
			"anthropic/claude-3-5-sonnet:high",
		);
		expect(entries.find((entry) => entry.role === "slow")).toMatchObject({ value: "web/exa" });
		expect(entries.find((entry) => entry.role === "slow")).not.toHaveProperty("provider");
		// The default role's fallback to the current model is not a configured value.
		expect(entries.find((entry) => entry.role === "default")).not.toHaveProperty("value");
	});

	test("resolves a role assigned to a non-chat model to provider/id", () => {
		const exa = { provider: "web", id: "exa", kind: "search" } as unknown as Model;
		settings.setModelRole("slow", "web/exa");
		const entry = catalog({ models: [...STUB_MODELS, exa] })!.find((e) => e.role === "slow");
		expect(entry).toMatchObject({ provider: "web", id: "exa", value: "web/exa" });
	});

	test("chat roles stay inside enabledModels while kind roles resolve from every kind", () => {
		const exa = { provider: "web", id: "exa", kind: "search" } as unknown as Model;
		// `enabledModels` admits only gpt-4o: the session's chat list is that one model,
		// while the registry's all-kinds pool has every authed model.
		const session = {
			getAvailableModels: () => [STUB_MODELS[0]],
			modelRegistry: {
				getAvailable: (kind?: string) => (kind === "all" ? [...STUB_MODELS, exa] : STUB_MODELS),
			},
		} as unknown as Parameters<typeof roleCatalogModels>[0];
		settings.setModelRole("smol", "anthropic/claude-3-5-sonnet");
		settings.setModelRole("plan", "openai/gpt-4o");
		settings.setModelRole("web", "web/exa");
		const entries = catalog({ models: roleCatalogModels(session) })!;
		expect(entries.find((e) => e.role === "smol")).toMatchObject({
			value: "anthropic/claude-3-5-sonnet",
		});
		expect(entries.find((e) => e.role === "smol")).not.toHaveProperty("provider");
		expect(entries.find((e) => e.role === "plan")).toMatchObject({
			provider: "openai",
			id: "gpt-4o",
		});
		expect(entries.find((e) => e.role === "web")).toMatchObject({ provider: "web", id: "exa" });
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

describe("createDaemonRosterGate", () => {
	const roster = (restartCount: number): DaemonInfo[] => [
		{ name: "dev", projectDir: "/p", state: "running", restartCount } as unknown as DaemonInfo,
	];

	test("sends the first roster and suppresses an identical one inside the heartbeat", () => {
		const gate = createDaemonRosterGate(30_000);
		expect(gate(roster(1), 0)).toBe(true);
		expect(gate(roster(1), 3_000)).toBe(false);
	});

	test("sends a changed roster immediately", () => {
		const gate = createDaemonRosterGate(30_000);
		gate(roster(1), 0);
		expect(gate(roster(2), 3_000)).toBe(true);
	});

	test("re-sends an unchanged roster once the heartbeat elapses", () => {
		const gate = createDaemonRosterGate(30_000);
		gate(roster(1), 0);
		expect(gate(roster(1), 30_000)).toBe(true);
	});

	test("sends an empty roster on transition, then suppresses repeats", () => {
		const gate = createDaemonRosterGate(30_000);
		gate(roster(1), 0);
		expect(gate([], 3_000)).toBe(true);
		expect(gate([], 6_000)).toBe(false);
	});
});
