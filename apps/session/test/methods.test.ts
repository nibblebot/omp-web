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
import { ENVELOPE_MAX_BYTES } from "#lib/wire/callback-protocol";
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

function webMethods() {
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
	});
}

function methodsTable() {
	return webMethods().methods;
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

	test("a failed prompt rebuild rolls the override back", async () => {
		// A distinct branch from the missing-prelude refusal above: the override
		// is already applied when the rebuild throws, so the catch must restore
		// the previous value before rethrowing.
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

	test("disabling needs no prelude and still rebuilds the prompt", async () => {
		const { entry, refreshes } = stubEntry({ preludes: [] });
		const methods = methodsTable();
		await methods.setComputerToolEnabled!(entry, [false]);
		expect(cfgComputerEnabled.get(entry.session.settings)).toBe(false);
		expect(refreshes()).toBe(1);
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

describe("getAvailableModels", () => {
	test("answers with ModelInfo rows that fit one callback envelope on a large catalog", async () => {
		// Full SDK rows carry per-model compat tables; ~1k of them ran past the
		// pair's 1 MiB envelope cap, so the answer was rejected and the picker timed out.
		const catalog = Array.from({ length: 1000 }, (_, i) => ({
			provider: `p${i % 8}`,
			id: `model-${i}`,
			contextWindow: 200_000,
			reasoning: true,
			thinking: { mode: "effort", efforts: ["low", "high"] },
			compat: { notes: "x".repeat(2_000) },
			cost: { input: 1, output: 2 },
			baseUrl: "https://example.invalid/v1",
		}));
		const entry = {
			session: {
				modelRegistry: { awaitBackgroundRefresh: async () => {} },
				getAvailableModels: () => catalog,
			},
		} as unknown as SessionEntry;
		const result = (await methodsTable().getAvailableModels!(entry, [])) as Array<
			Record<string, unknown>
		>;
		expect(result).toHaveLength(1000);
		expect(Object.keys(result[0]!).sort()).toEqual([
			"contextWindow",
			"id",
			"provider",
			"reasoning",
			"thinking",
		]);
		expect(result[0]!.thinking).toEqual(catalog[0]!.thinking);
		expect(JSON.stringify(result).length).toBeLessThan(ENVELOPE_MAX_BYTES);
	});
});

describe("setThinkingLevel", () => {
	test("rejects a level the active model does not offer", async () => {
		const entry = {
			session: {
				model: { provider: "anthropic", id: "haiku" },
				getAvailableEffortSelectors: () => ["off", "low"],
				setThinkingLevel: () => {
					throw new Error("must not apply");
				},
			},
		} as unknown as SessionEntry;
		await expect(methodsTable().setThinkingLevel!(entry, ["high"])).rejects.toThrow(
			'Thinking "high" is not supported by anthropic/haiku. Supported: off, low.',
		);
	});
});

describe("getModelBrowser", () => {
	test("marks models without credentials as locked and leaves usable ones open", async () => {
		const usable = { provider: "anthropic", id: "opus", contextWindow: 1, reasoning: true };
		const locked = { provider: "openai", id: "gpt", contextWindow: 1, reasoning: false };
		const entry = {
			session: {
				settings: Settings.isolated(),
				modelRegistry: {
					awaitBackgroundRefresh: async () => {},
					getAll: () => [usable, locked],
					getAvailable: () => [usable],
				},
			},
		} as unknown as SessionEntry;
		const rows = (await methodsTable().getModelBrowser!(entry, [])) as Array<
			Record<string, unknown>
		>;
		expect(rows[0]).not.toHaveProperty("locked");
		expect(rows[1]!.locked).toBe("credentials");
	});

	test("answers a full registry inside one callback envelope", async () => {
		// Full SDK rows with compat tables ran past the 1 MiB cap; the browser
		// projects each row to provider/id/context/reasoning plus a lock code.
		const registry = Array.from({ length: 5000 }, (_, i) => ({
			provider: `provider-${i % 40}`,
			id: `model-with-a-long-identifier-${i}`,
			contextWindow: 200_000,
			reasoning: true,
			thinking: { mode: "effort", efforts: ["low", "high"] },
			compat: { notes: "x".repeat(2_000) },
		}));
		const entry = {
			session: {
				settings: Settings.isolated(),
				modelRegistry: {
					awaitBackgroundRefresh: async () => {},
					getAll: () => registry,
					getAvailable: () => [],
				},
			},
		} as unknown as SessionEntry;
		const rows = (await methodsTable().getModelBrowser!(entry, [])) as unknown[];
		expect(rows).toHaveLength(5000);
		expect(JSON.stringify(rows).length).toBeLessThan(ENVELOPE_MAX_BYTES);
	});
});

/** Message-only transcript stub for the graph rows, oldest first on disk. */
function graphEntry() {
	const entries = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: "first question" },
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2026-01-01T00:00:01.000Z",
			message: { role: "assistant", content: [{ type: "text", text: "first answer" }] },
		},
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "user", content: "second question" },
		},
	];
	const sessionManager = {
		getEntries: () => entries,
		getEntry: (id: string) => entries.find((entry) => entry.id === id),
		getLeafId: () => "u2",
		getLabel: () => undefined,
		getHeader: () => undefined,
	};
	const session = { sessionId: "sess-graph", sessionManager };
	return { entry: { handle: "s1", session } as unknown as SessionEntry };
}

describe("session graph rows", () => {
	test("getSessionGraph pages the transcript newest first and filters by kind", async () => {
		const { entry } = graphEntry();
		const methods = methodsTable();
		const page = (await methods.getSessionGraph!(entry, [{ limit: 2 }])) as {
			nodes: Array<{ id: string; type: string }>;
			hasMore: boolean;
			nextCursor: string | null;
		};
		expect(page.nodes.map((node) => node.id)).toEqual(["u2", "a1"]);
		expect(page.hasMore).toBe(true);
		expect(page.nextCursor).toEqual(expect.any(String));
		const users = (await methods.getSessionGraph!(entry, [{ filter: "user" }])) as {
			nodes: Array<{ id: string; type: string }>;
		};
		expect(users.nodes.map((node) => node.type)).toEqual(["user", "user"]);
	});

	test("getSessionGraph refuses a cursor that belongs to another filter", async () => {
		const { entry } = graphEntry();
		const methods = methodsTable();
		const page = (await methods.getSessionGraph!(entry, [{ limit: 1 }])) as {
			nextCursor: string;
		};
		await expect(
			methods.getSessionGraph!(entry, [{ limit: 1, filter: "user", cursor: page.nextCursor }]),
		).rejects.toThrow("stale or belongs to another query");
	});

	test("navigateTree refuses a selection whose revision is not the current one", async () => {
		const { entry } = graphEntry();
		const methods = methodsTable();
		await expect(
			methods.navigateTree!(entry, ["u1", { revision: "not-the-current-revision" }]),
		).rejects.toThrow("Graph selection is stale; reload and re-pick");
	});
});

describe("READ_ONLY classification", () => {
	// Methods that change session state, write to disk, or start model work. Every
	// other method must be classified read-only so a call does not trigger a state resync.
	const MUTATING: Record<string, true> = {
		abort: true,
		abortAndPrompt: true,
		abortBash: true,
		abortCompaction: true,
		abortEphemeral: true,
		abortEval: true,
		abortRetry: true,
		advisorConfigure: true,
		annotationCompose: true,
		annotationCreate: true,
		annotationReanchor: true,
		annotationRemove: true,
		annotationUpdate: true,
		applyModelPreset: true,
		bash: true,
		btwCancel: true,
		btwFollowUp: true,
		btwStart: true,
		clearModelRole: true,
		clearQueue: true,
		cycleModel: true,
		cycleThinkingLevel: true,
		deleteModelPreset: true,
		dropImages: true,
		dumpSessionArchive: true,
		exportDownload: true,
		exportHtml: true,
		followUp: true,
		foreignImport: true,
		foreignUploadCancel: true,
		foreignUploadStage: true,
		freshSession: true,
		gitCommit: true,
		gitStage: true,
		gitStageHunks: true,
		gitUnstage: true,
		goalBudget: true,
		goalCreate: true,
		goalDrop: true,
		goalPause: true,
		goalReplace: true,
		goalResume: true,
		lineageResume: true,
		login: true,
		loopCancel: true,
		loopPause: true,
		loopResume: true,
		loopStart: true,
		materializeSession: true,
		mcpAdd: true,
		mcpDisable: true,
		mcpEnable: true,
		mcpOAuthRevoke: true,
		mcpReconnect: true,
		mcpRemove: true,
		mcpUpdate: true,
		planCancel: true,
		planDecide: true,
		planGet: true,
		planReopen: true,
		popLastQueuedMessage: true,
		predictNextMessage: true,
		prompt: true,
		python: true,
		queueCommand: true,
		reloadIntegrations: true,
		resumeDelete: true,
		resumePinToggle: true,
		resumeQueue: true,
		retry: true,
		runEphemeralTurn: true,
		runQueuedCommandNow: true,
		runQueuedNow: true,
		saveModelPreset: true,
		setAutoCompaction: true,
		setAutoRetry: true,
		setComputerToolEnabled: true,
		setFastMode: true,
		setFollowUpMode: true,
		setGoalModeState: true,
		setInspectImageMode: true,
		setInterruptMode: true,
		setModel: true,
		setModelRole: true,
		setModelRoleHidden: true,
		setPlanModeState: true,
		setPluginEnabled: true,
		setPluginFeatures: true,
		setPluginSetting: true,
		setSetting: true,
		setSkillEnabled: true,
		setSteeringMode: true,
		setTaskModel: true,
		setThinkingLevel: true,
		shake: true,
		steer: true,
		subagentAbort: true,
		subagentSteer: true,
		switchModel: true,
		takeQueued: true,
		takeQueuedCommand: true,
		todoApply: true,
		todoImport: true,
		unsetSetting: true,
		vibeKill: true,
		vibeKillAll: true,
		vibeRehydrate: true,
		vibeSend: true,
		vibeSetMode: true,
		vibeSpawn: true,
		vibeWait: true,
		workerList: true,
		workerPark: true,
		workerRevive: true,
	};

	test("every method is classified read-only, name-only, history-reload, or mutating", () => {
		const web = webMethods();
		const unclassified = Object.keys(web.methods).filter(
			(name) =>
				!(name in web.readOnly) &&
				!(name in web.nameOnly) &&
				!(name in web.historyReload) &&
				!(name in MUTATING),
		);
		expect(unclassified).toEqual([]);
	});

	test("READ_ONLY and the mutating list name real methods, never the same one", () => {
		const web = webMethods();
		expect(Object.keys(web.readOnly).filter((name) => !(name in web.methods))).toEqual([]);
		expect(Object.keys(MUTATING).filter((name) => !(name in web.methods))).toEqual([]);
		expect(Object.keys(MUTATING).filter((name) => name in web.readOnly)).toEqual([]);
	});

	test("getToolSchemas answers the live tool list on demand", async () => {
		const tools = [
			{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
		];
		const entry = { session: { agent: { state: { tools } } } } as unknown as SessionEntry;
		const result = (await methodsTable().getToolSchemas!(entry, [])) as Array<{
			name: string;
			description: string;
		}>;
		expect(result.map((t) => [t.name, t.description])).toEqual([["read", "Read a file"]]);
	});
});
