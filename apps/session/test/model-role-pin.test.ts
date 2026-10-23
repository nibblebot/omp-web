import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import {
	findActiveModelPreset,
	type ModelPresetSession,
} from "@oh-my-pi/pi-coding-agent/config/model-presets";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import {
	activeModelPreset,
	applyPinnedModelPreset,
	pinModelRoles,
	repinModelRole,
	retakeModelRolePin,
} from "../model-role-pin";

afterAll(cleanupTempDirs);

const CONFIG = `defaultThinkingLevel: high
modelRoles:
  default: a/one
  smol: a/small
  slow: a/slow
modelPresets:
  base:
    modelRoles:
      default: a/one
      smol: a/small
      slow: a/slow
    defaultThinkingLevel: high
  fast:
    modelRoles:
      default: b/two
      smol: b/small
    defaultThinkingLevel: low
`;

const BASE_ROLES = { default: "a/one", smol: "a/small", slow: "a/slow" };
const FAST_ROLES = { default: "b/two", smol: "b/small" };

const MODELS = ["a/one", "a/small", "a/slow", "b/two", "b/small"].map((selector) => {
	const [provider, id] = selector.split("/");
	return { provider, id, name: id } as unknown as Model;
});

function fakeSession(models: Model[] = MODELS) {
	const live: { model?: Model; thinking?: string } = {};
	const session = {
		scopedModels: [],
		getAvailableModels: () => models,
		modelRegistry: { hasConfiguredAuth: () => true, hasConcreteAuth: () => true },
		setModel: async (model: Model) => {
			live.model = model;
		},
		setThinkingLevel: (level: string) => {
			live.thinking = level;
		},
	} as unknown as ModelPresetSession;
	return { session, live };
}

/** Two running sessions: daemon processes sharing one config.yml, each pinned at boot. */
async function twoDaemons() {
	const dir = tempDir("omp-model-pin-");
	writeFileSync(join(dir, "config.yml"), CONFIG);
	const a = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
	const b = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
	pinModelRoles(a);
	pinModelRoles(b);
	return { dir, a, b };
}

describe("model role pin", () => {
	test("a preset applied in one session persists without moving another running session", async () => {
		const { dir, a, b } = await twoDaemons();
		const { session, live } = fakeSession();

		const result = await applyPinnedModelPreset(a, session, "fast");

		expect(result.kind).toBe("switched");
		expect(live.model?.id).toBe("two");
		expect(live.thinking).toBe("low");
		expect(a.getModelRoles()).toEqual(FAST_ROLES);
		expect(activeModelPreset(a)).toBe("fast");

		await a.flush();
		await b.reloadFromDisk();
		expect(readFileSync(join(dir, "config.yml"), "utf8")).toContain("default: b/two");
		expect(b.getModelRoles()).toEqual(BASE_ROLES);
		expect(activeModelPreset(b)).toBe("base");

		// A session started after the apply gets the persisted preset.
		const fresh = await Settings.loadIsolated({ agentDir: dir, cwd: dir });
		expect(findActiveModelPreset(fresh)).toBe("fast");
	});

	test("a role this session unset stays unset through reloads and its own role edits", async () => {
		const { a, b } = await twoDaemons();
		await applyPinnedModelPreset(a, fakeSession().session, "fast");
		await a.flush();

		// Another session assigns `slow` in config.yml; this session left it out.
		await b.reloadFromDisk();
		b.setModelRole("slow", "c/slow");
		repinModelRole(b, "slow");
		expect(b.getModelRoles()).toEqual({ ...BASE_ROLES, slow: "c/slow" });
		await b.flush();
		await a.reloadFromDisk();
		expect(a.getModelRoles()).toEqual(FAST_ROLES);

		// The SDK rebuilds the runtime role map on a role write; the pin keeps the tombstone.
		a.setModelRole("smol", "c/x");
		repinModelRole(a, "smol");
		expect(a.getModelRoles()).toEqual({ default: "b/two", smol: "c/x" });
	});

	test("a refused apply leaves the session's pin in place", async () => {
		const { a, b } = await twoDaemons();
		await applyPinnedModelPreset(b, fakeSession().session, "fast");
		await b.flush();
		await a.reloadFromDisk();

		const { session, live } = fakeSession([MODELS[0]]);
		const result = await applyPinnedModelPreset(a, session, "fast");

		expect(result).toEqual({
			kind: "unavailable",
			reason: "default model `b/two` is not available",
		});
		expect(live.model).toBeUndefined();
		expect(a.getModelRoles()).toEqual(BASE_ROLES);
		expect(activeModelPreset(a)).toBe("base");
	});

	test("an apply that throws keeps the session's pin", async () => {
		const { a, b } = await twoDaemons();
		const { session } = fakeSession();
		const throwing = { ...session, scopedModels: null } as unknown as ModelPresetSession;
		await expect(applyPinnedModelPreset(a, throwing, "fast")).rejects.toThrow();

		await applyPinnedModelPreset(b, fakeSession().session, "fast");
		await b.flush();
		await a.reloadFromDisk();
		expect(a.getModelRoles()).toEqual(BASE_ROLES);
	});

	test("a new session in a running daemon re-pins to the persisted preset", async () => {
		const { a, b } = await twoDaemons();
		await applyPinnedModelPreset(a, fakeSession().session, "fast");
		await a.flush();
		await b.reloadFromDisk();
		expect(activeModelPreset(b)).toBe("base");

		retakeModelRolePin(b);

		expect(b.getModelRoles()).toEqual(FAST_ROLES);
		expect(activeModelPreset(b)).toBe("fast");
	});
});
