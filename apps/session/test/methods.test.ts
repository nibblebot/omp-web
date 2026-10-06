/**
 * Unit tests for the SDK-drift-sensitive rows of the web methods table
 * (apps/session/methods.ts). These rows are the ones 18.x rewrote: computer use is
 * an eval prelude gated by the session-scoped `computer.enabled` setting, and
 * the inspect_image tool is gone. A real daemon covers the reachable wire
 * behavior (apps/session/test/omp-session.test.ts); the branches that depend on session
 * internals (no active prelude, a failing prompt rebuild) are driven here with
 * a stub session so the parity logic is asserted directly.
 */

import { describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgModelRoleStorage, cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { createWebMethods } from "../methods";
import type { SessionEntry } from "../session-entry";

interface StubSession {
	settings: Settings;
	getEvalPreludes: () => ReadonlyArray<{ name: string }>;
	refreshBaseSystemPrompt: () => Promise<void>;
}

/** A session stub recording the override writes and prompt rebuilds it saw. */
function stubEntry(opts: { preludes?: ReadonlyArray<{ name: string }>; refreshError?: Error }): {
	entry: SessionEntry;
	overrides: Array<boolean>;
	refreshes: () => number;
} {
	const settings = Settings.isolated();
	let refreshes = 0;
	const session: StubSession = {
		settings,
		getEvalPreludes: () => opts.preludes ?? [],
		refreshBaseSystemPrompt: async () => {
			refreshes++;
			if (opts.refreshError) throw opts.refreshError;
		},
	};
	return {
		entry: { session } as unknown as SessionEntry,
		overrides: [],
		refreshes: () => refreshes,
	};
}

function methodsTable() {
	return createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: {} as never,
		broker: {} as never,
		// Clone-workspace deps (P8.9 wake): unused by these rows, so inert doubles.
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		cwd: "/tmp/fleet-test-cwd",
		hasCallbackPair: () => false,
	}).methods;
}

describe("computer/inspect_image rows after the 18.x drift", () => {
	test("enabling without an active computer prelude reverts the override and refuses", async () => {
		// Parity with the SDK's own /computer toggle (applyComputerUseToggle):
		// the prelude only exists while the eval tool is active, so a session
		// without one must not be left believing computer use is on.
		const { entry, refreshes } = stubEntry({ preludes: [] });
		const methods = methodsTable();
		await expect(methods.setComputerToolEnabled!(entry, [true])).rejects.toThrow(
			"unavailable in this session",
		);
		expect(cfgComputerEnabled.get(entry.session.settings)).toBe(false);
		expect(refreshes()).toBe(0);
	});

	test("enabling with an active prelude keeps the override and rebuilds the prompt", async () => {
		const { entry, refreshes } = stubEntry({ preludes: [{ name: "computer" }] });
		const methods = methodsTable();
		await methods.setComputerToolEnabled!(entry, [true]);
		expect(cfgComputerEnabled.get(entry.session.settings)).toBe(true);
		expect(refreshes()).toBe(1);
	});

	test("disabling needs no prelude and still rebuilds the prompt", async () => {
		const { entry, refreshes } = stubEntry({ preludes: [] });
		const methods = methodsTable();
		await methods.setComputerToolEnabled!(entry, [false]);
		expect(cfgComputerEnabled.get(entry.session.settings)).toBe(false);
		expect(refreshes()).toBe(1);
	});

	test("a failed prompt rebuild rolls the override back", async () => {
		const { entry } = stubEntry({
			preludes: [{ name: "computer" }],
			refreshError: new Error("prompt rebuild exploded"),
		});
		const methods = methodsTable();
		await expect(methods.setComputerToolEnabled!(entry, [true])).rejects.toThrow(
			"prompt rebuild exploded",
		);
		expect(cfgComputerEnabled.get(entry.session.settings)).toBe(false);
	});

	test("setInspectImageMode is a loud tombstone, never a silent success", () => {
		const { entry, refreshes } = stubEntry({ preludes: [{ name: "computer" }] });
		const methods = methodsTable();
		// The row throws synchronously; the dispatch core turns that into an
		// ok:false call_result (asserted over the wire in omp-session.test.ts).
		expect(() => methods.setInspectImageMode!(entry, ["auto"])).toThrow("inspect_image");
		expect(refreshes()).toBe(0);
	});
});

describe("model-role registry settings preserve scope and cancellation", () => {
	test("a cancelled default-model switch never overwrites a project assignment", async () => {
		const settings = Settings.isolated();
		cfgModelRoleStorage.override(settings, "project");
		settings.setProjectModelRole("default", "openai/previous:low");
		const selected = { provider: "openai", id: "selected" };
		const switches: unknown[] = [];
		const entry = {
			session: {
				settings,
				getAvailableModels: () => [selected],
				setModel: async (_model: unknown, _role: string, options: unknown) => {
					switches.push(options);
					return { switched: false };
				},
			},
		} as unknown as SessionEntry;
		await methodsTable().setModelRole!(entry, ["default", "openai", "selected", "inherit"]);
		expect(switches).toEqual([{ thinkingLevel: undefined, persist: false }]);
		expect(settings.getProjectModelRole("default")).toBe("openai/previous:low");
	});

	test("inherit omits baked thinking and writes a non-active role only in project scope", async () => {
		const settings = Settings.isolated();
		cfgModelRoleStorage.override(settings, "project");
		settings.setModelRole("smol", "openai/global:high");
		const selected = { provider: "openai", id: "selected" };
		const entry = {
			session: {
				settings,
				getAvailableModels: () => [selected],
				getRoleModelCycle: () => undefined,
			},
		} as unknown as SessionEntry;
		await methodsTable().setModelRole!(entry, ["smol", "openai", "selected", "inherit"]);
		expect(settings.getProjectModelRole("smol")).toBe("openai/selected");
		expect(settings.getModelRoleSource("smol")).toBe("project");
		settings.clearProjectModelRole("smol");
		expect(settings.getModelRole("smol")).toBe("openai/global:high");
	});

	test("clearing an active project role reveals and applies inherited global thinking", async () => {
		const settings = Settings.isolated();
		cfgModelRoleStorage.override(settings, "project");
		settings.setModelRole("smol", "openai/global:high");
		settings.setProjectModelRole("smol", "openai/project:low");
		const global = { provider: "openai", id: "global" };
		const project = { provider: "openai", id: "project" };
		const applied: unknown[] = [];
		const entry = {
			session: {
				settings,
				model: project,
				getAvailableModels: () => [global, project],
				getRoleModelCycle: () => ({ models: [{ role: "smol", model: project }], currentIndex: 0 }),
				applyRoleModel: async (value: unknown) => {
					applied.push(value);
				},
			},
		} as unknown as SessionEntry;
		await methodsTable().clearModelRole!(entry, ["smol"]);
		expect(settings.getProjectModelRole("smol")).toBeUndefined();
		expect(settings.getModelRole("smol")).toBe("openai/global:high");
		expect(applied).toEqual([
			{ role: "smol", model: global, thinkingLevel: "high", explicitThinkingLevel: true },
		]);
	});

	test("hiding a role keeps other registry tags and its assignment intact", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("writer", "openai/selected");
		cfgModelTags.set(settings, { writer: { name: "Writer" }, smol: { name: "Fast" } });
		const entry = { session: { settings } } as unknown as SessionEntry;
		await methodsTable().setModelRoleHidden!(entry, ["writer", true]);
		expect(cfgModelTags.get(settings)).toEqual({
			writer: { name: "Writer", hidden: true },
			smol: { name: "Fast" },
		});
		expect(settings.getModelRole("writer")).toBe("openai/selected");
	});
});

interface StubModel {
	provider: string;
	id: string;
}

interface LiveEffortSession {
	settings: Settings;
	model: StubModel;
	thinkingLevel: string | undefined;
}

/**
 * Session double holding the SDK's live-effort contract: setModel switches the
 * model (persisting the role when asked) but keeps the current effort; only
 * setThinkingLevel and applyRoleModel's explicit selector change it.
 */
function liveEffortEntry(
	settings: Settings,
	models: StubModel[],
	live: { model: StubModel; thinkingLevel: string },
): { entry: SessionEntry; session: LiveEffortSession } {
	const session = {
		settings,
		model: live.model,
		thinkingLevel: live.thinkingLevel as string | undefined,
		getAvailableModels: () => models,
		getRoleModelCycle: () => ({
			models: [{ role: "default", model: session.model }],
			currentIndex: 0,
		}),
		setModel: async (model: StubModel) => {
			session.model = model;
			return { switched: true };
		},
		setThinkingLevel: (level: string | undefined) => {
			session.thinkingLevel = level;
		},
		applyRoleModel: async (resolved: {
			model: StubModel;
			thinkingLevel?: string;
			explicitThinkingLevel: boolean;
		}) => {
			session.model = resolved.model;
			if (resolved.explicitThinkingLevel && resolved.thinkingLevel !== undefined) {
				session.thinkingLevel = resolved.thinkingLevel;
			}
		},
	};
	return { entry: { session } as unknown as SessionEntry, session };
}

describe("default-role mutations drive the live thinking level", () => {
	const opus = { provider: "anthropic", id: "claude-opus-5-5" };

	test("assigning the default role applies its picked level to a session at another level", async () => {
		const { entry, session } = liveEffortEntry(Settings.isolated(), [opus], {
			model: opus,
			thinkingLevel: "max",
		});
		await methodsTable().setModelRole!(entry, ["default", "anthropic", "claude-opus-5-5", "high"]);
		expect(session.thinkingLevel).toBe("high");
	});

	test("assigning the default role with inherit keeps the live level", async () => {
		const { entry, session } = liveEffortEntry(Settings.isolated(), [opus], {
			model: opus,
			thinkingLevel: "max",
		});
		await methodsTable().setModelRole!(entry, [
			"default",
			"anthropic",
			"claude-opus-5-5",
			"inherit",
		]);
		expect(session.thinkingLevel).toBe("max");
	});

	test("clearing the active project default applies the revealed global level", async () => {
		const settings = Settings.isolated();
		cfgModelRoleStorage.override(settings, "project");
		settings.setModelRole("default", "openai/global:high");
		settings.setProjectModelRole("default", "openai/project:low");
		const global = { provider: "openai", id: "global" };
		const project = { provider: "openai", id: "project" };
		const { entry, session } = liveEffortEntry(settings, [global, project], {
			model: project,
			thinkingLevel: "low",
		});
		await methodsTable().clearModelRole!(entry, ["default"]);
		expect(session.model).toEqual(global);
		expect(session.thinkingLevel).toBe("high");
	});
});
