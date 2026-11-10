/**
 * Unit tests for the web methods table (apps/session/methods.ts): model-role
 * registry scope and cancellation, default-role mutations that drive the live
 * thinking level, and setThinkingLevel validation.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { cfgModelRoleStorage, cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { ENVELOPE_MAX_BYTES } from "#lib/wire/callback-protocol";
import { TOOL_BRIEF_DESCRIPTION_CHARS } from "#lib/wire/protocol";
import type { DownloadManifestResult } from "../download-manifest";
import { createWebMethods } from "../methods";
import type { SessionEntry } from "../session-entry";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

function webMethods() {
	return createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: {} as never,
		broker: {} as never,
		// Clone-workspace deps (wake): unused by these rows, so inert doubles.
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		cwd: "/tmp/fleet-test-cwd",
		hasCallbackPair: () => false,
	});
}

function methodsTable() {
	return webMethods().methods;
}

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
				scopedModels: [],
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

	test("marks only in-scope rows when the session has a model scope", async () => {
		const inScope = { provider: "anthropic", id: "opus", contextWindow: 1, reasoning: true };
		const outOfScope = { provider: "openai", id: "gpt", contextWindow: 1, reasoning: false };
		const registry = {
			awaitBackgroundRefresh: async () => {},
			getAll: () => [inScope, outOfScope],
			getAvailable: () => [inScope, outOfScope],
		};
		const entryWith = (scopedModels: unknown[]) =>
			({
				session: { settings: Settings.isolated(), scopedModels, modelRegistry: registry },
			}) as unknown as SessionEntry;

		const scoped = (await methodsTable().getModelBrowser!(
			entryWith([{ model: inScope }]),
			[],
		)) as Array<Record<string, unknown>>;
		expect(scoped[0]!.scoped).toBe(true);
		expect(scoped[1]).not.toHaveProperty("scoped");

		const unscoped = (await methodsTable().getModelBrowser!(entryWith([]), [])) as Array<
			Record<string, unknown>
		>;
		expect(unscoped[0]).not.toHaveProperty("scoped");
		expect(unscoped[1]).not.toHaveProperty("scoped");
	});

	test("carries each row's kind and marks a keyed non-chat model usable", async () => {
		const chat = { provider: "anthropic", id: "opus", contextWindow: 1, reasoning: true };
		const search = {
			provider: "web",
			id: "exa",
			kind: "search",
			contextWindow: 0,
			reasoning: false,
		};
		const asked: unknown[] = [];
		const entry = {
			session: {
				settings: Settings.isolated(),
				scopedModels: [],
				modelRegistry: {
					awaitBackgroundRefresh: async () => {},
					getAll: () => [chat, search],
					// Mirrors the registry: the chat-only default hides keyed non-chat models.
					getAvailable: (kind: unknown = "chat") => {
						asked.push(kind);
						return kind === "all" ? [chat, search] : [chat];
					},
				},
			},
		} as unknown as SessionEntry;
		const rows = (await methodsTable().getModelBrowser!(entry, [])) as Array<
			Record<string, unknown>
		>;
		expect(asked).toEqual(["all"]);
		expect(rows[0]!.kind).toBe("chat");
		expect(rows[1]!.kind).toBe("search");
		expect(rows[1]).not.toHaveProperty("locked");
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
				scopedModels: [],
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

describe("getModelBrowser thinkingEfforts", () => {
	test("lists the model's own efforts in SDK order for reasoning models only", async () => {
		const reasoning = {
			provider: "anthropic",
			id: "opus",
			contextWindow: 1,
			reasoning: true,
			thinking: { mode: "effort", efforts: ["low", "medium", "high", "xhigh"] },
		};
		const plain = { provider: "openai", id: "gpt", contextWindow: 1, reasoning: false };
		// A non-reasoning model never offers efforts, even if stale metadata lists some.
		const stale = {
			provider: "openai",
			id: "old",
			contextWindow: 1,
			reasoning: false,
			thinking: { mode: "effort", efforts: ["low"] },
		};
		const entry = {
			session: {
				settings: Settings.isolated(),
				scopedModels: [],
				modelRegistry: {
					awaitBackgroundRefresh: async () => {},
					getAll: () => [reasoning, plain, stale],
					getAvailable: () => [reasoning, plain, stale],
				},
			},
		} as unknown as SessionEntry;
		const rows = (await methodsTable().getModelBrowser!(entry, [])) as Array<
			Record<string, unknown>
		>;
		expect(rows[0]!.thinkingEfforts).toEqual(["low", "medium", "high", "xhigh"]);
		expect(rows[1]).not.toHaveProperty("thinkingEfforts");
		expect(rows[2]).not.toHaveProperty("thinkingEfforts");
	});

	test("every emitted effort is a level setModelRole accepts", async () => {
		const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"];
		const model = {
			provider: "a",
			id: "m",
			contextWindow: 1,
			reasoning: true,
			thinking: { mode: "effort", efforts },
		};
		const settings = Settings.isolated();
		const entry = {
			session: {
				settings,
				scopedModels: [],
				getAvailableModels: () => [model],
				setModel: async () => ({ switched: true }),
				setThinkingLevel: () => {},
				getRoleModelCycle: () => undefined,
				modelRegistry: {
					awaitBackgroundRefresh: async () => {},
					getAll: () => [model],
					getAvailable: () => [model],
				},
			},
		} as unknown as SessionEntry;
		const rows = (await methodsTable().getModelBrowser!(entry, [])) as Array<{
			thinkingEfforts?: string[];
		}>;
		expect(rows[0]!.thinkingEfforts).toEqual(efforts);
		for (const level of rows[0]!.thinkingEfforts!) {
			await methodsTable().setModelRole!(entry, ["smol", "a", "m", level]);
			expect(settings.getModelRole("smol")).toBe(`a/m:${level}`);
		}
	});
});

describe("getModelPresets", () => {
	test("lists contents with the owning layer and the SDK reason for a malformed preset", async () => {
		const agentDir = tempDir("omp-presets-agent-");
		const cwd = tempDir("omp-presets-cwd-");
		writeFileSync(
			join(agentDir, "config.yml"),
			`modelRoles:
  default: a/one
defaultThinkingLevel: high
modelPresets:
  base:
    modelRoles:
      default: a/one
      smol: a/small:low
    defaultThinkingLevel: high
  broken:
    modelRoles: nope
  shadowed:
    modelRoles:
      default: g/global
`,
		);
		mkdirSync(join(cwd, ".omp"), { recursive: true });
		writeFileSync(
			join(cwd, ".omp", "config.yml"),
			`modelPresets:
  team:
    modelRoles:
      default: p/proj
  shadowed:
    modelRoles:
      default: p/project
`,
		);
		const settings = await Settings.loadIsolated({ agentDir, cwd });
		const entry = { session: { settings } } as unknown as SessionEntry;
		const answer = (await methodsTable().getModelPresets!(entry, [])) as {
			names: string[];
			active?: string;
			presets: Array<Record<string, unknown>>;
		};
		expect(answer.names).toEqual(["base", "broken", "shadowed", "team"]);
		expect(answer.presets.map((p) => p.name)).toEqual(answer.names);
		const byName = Object.fromEntries(answer.presets.map((p) => [p.name as string, p]));
		expect(byName.base).toEqual({
			name: "base",
			source: "global",
			modelRoles: { default: "a/one", smol: "a/small:low" },
			defaultThinkingLevel: "high",
		});
		expect(byName.team).toEqual({
			name: "team",
			source: "project",
			modelRoles: { default: "p/proj" },
		});
		expect(byName.shadowed).toMatchObject({
			source: "project",
			modelRoles: { default: "p/project" },
		});
		expect(byName.broken).toEqual({
			name: "broken",
			source: "global",
			modelRoles: {},
			invalid: "`modelRoles` is missing or not a mapping",
		});
	});

	test("reports a runtime-layer preset as runtime", async () => {
		const settings = Settings.isolated({
			modelPresets: { live: { modelRoles: { default: "r/one" } } },
		});
		const entry = { session: { settings } } as unknown as SessionEntry;
		const answer = (await methodsTable().getModelPresets!(entry, [])) as {
			presets: Array<Record<string, unknown>>;
		};
		expect(answer.presets).toEqual([
			{ name: "live", source: "runtime", modelRoles: { default: "r/one" } },
		]);
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

	test("reanswerAsk is a mutating transcript reload, like navigateTree", () => {
		const web = webMethods();
		expect(web.methods.reanswerAsk).toBeFunction();
		expect(web.readOnly.reanswerAsk).toBeUndefined();
		expect(web.historyReload.reanswerAsk).toBe(true);
		expect(web.notReadyGated.reanswerAsk).toBeUndefined();
	});
});

describe("transcript-rewriting rows", () => {
	// One table set for both rows: the rewrite classification and the compaction gate.
	// The broker records the session's compacting flag at each state broadcast.
	const broadcasts: boolean[] = [];
	const tables = createWebMethods({
		settings: {} as never,
		authStorage: {} as never,
		collab: {} as never,
		broker: {
			broadcastState: async (entry: SessionEntry) => {
				broadcasts.push(entry.session.isCompacting);
			},
		} as never,
		materializeSession: async () => ({ alreadyPresent: true as const }),
		sessionsDir: "/tmp/fleet-test-sessions",
		cwd: "/tmp/fleet-test-cwd",
		hasCallbackPair: () => false,
	});

	test("every row that rewrites the transcript resyncs history (HISTORY_RELOAD)", () => {
		// The browser only follows a rewrite through the history resync, so each
		// rewriting row must be in the table: shake and dropImages were not.
		for (const name of ["compactEx", "shake", "dropImages", "handoff", "clearSession"] as const) {
			expect(tables.historyReload[name]).toBe(true);
		}
	});

	test("compact is not a second compaction path; compactEx refuses while no model is selected", async () => {
		// The raw `compact` row bypassed the eligibility gate that compactEx and
		// the Compact… dialog enforce. Only the gated compactEx remains.
		const compacts: unknown[] = [];
		const session = {
			settings: Settings.isolated(),
			model: undefined,
			isStreaming: false,
			hasPostPromptWork: false,
			isCompacting: false,
			compact: async (...args: unknown[]) => {
				compacts.push(args);
				return {};
			},
		};
		const entry = { session } as unknown as SessionEntry;
		expect(Object.hasOwn(tables.methods, "compact")).toBe(false);
		const outcome = (await tables.methods.compactEx!(entry, [{ mode: "soft" }])) as {
			ok: boolean;
			failureKind?: string;
		};
		expect(outcome.ok).toBe(false);
		expect(outcome.failureKind).toBe("unavailable");
		expect(compacts).toEqual([]);
	});

	test("compactEx without a mode leaves method choice to the configured order; an explicit mode is kept", async () => {
		// Bare /compact used to be forced to soft, skipping a remote-first
		// compaction.methodOrder that the SDK's own /compact honours.
		const compacts: Array<[unknown, unknown]> = [];
		const session = {
			settings: Settings.isolated(),
			model: { api: "openai-completions", provider: "openai", input: ["text"], compat: {} },
			isStreaming: false,
			hasPostPromptWork: false,
			isCompacting: false,
			compact: async (instructions: unknown, options: unknown) => {
				compacts.push([instructions, options]);
				return { summary: "s", firstKeptEntryId: "e1" };
			},
			getContextUsage: () => undefined,
			getContextBreakdown: () => undefined,
			sessionManager: { getBranch: () => [{ type: "compaction", method: "remote" }] },
		};
		const entry = { session } as unknown as SessionEntry;
		const bare = (await tables.methods.compactEx!(entry, [{ instructions: "focus" }])) as {
			ok: boolean;
			data?: { mode?: string; appliedMethod?: string };
		};
		expect(bare.ok).toBe(true);
		expect(bare.data?.mode).toBeUndefined();
		expect(bare.data?.appliedMethod).toBe("remote");
		await tables.methods.compactEx!(entry, [{ mode: "soft" }]);
		const unknown = (await tables.methods.compactEx!(entry, [{ mode: "bogus" }])) as {
			ok: boolean;
			failureKind?: string;
		};
		expect(compacts).toEqual([
			["focus", {}],
			[undefined, { mode: "soft" }],
		]);
		expect(unknown).toMatchObject({ ok: false, failureKind: "invalid_request" });
	});

	test("compactEx and handoff publish the compacting state while the run is still in flight", async () => {
		// The post-call state broadcast only lands after the run settles, so
		// without a start broadcast browsers never saw compaction in progress.
		const settle = Promise.withResolvers<void>();
		const session = {
			settings: Settings.isolated(),
			model: { api: "openai-completions", provider: "openai", input: ["text"], compat: {} },
			isStreaming: false,
			hasPostPromptWork: false,
			isCompacting: false,
			compact: async () => {
				session.isCompacting = true;
				await settle.promise;
				session.isCompacting = false;
				return { summary: "s", firstKeptEntryId: "e1" };
			},
			handoff: async () => {
				session.isCompacting = true;
				await settle.promise;
				session.isCompacting = false;
				return { document: "d" };
			},
			getContextUsage: () => undefined,
			getContextBreakdown: () => undefined,
			sessionManager: { getBranch: () => [] },
		};
		const entry = { session } as unknown as SessionEntry;
		broadcasts.length = 0;
		const compacting = tables.methods.compactEx!(entry, [{}]);
		await Promise.resolve();
		expect(broadcasts).toEqual([true]);
		settle.resolve();
		await compacting;
		broadcasts.length = 0;
		const handingOff = tables.methods.handoff!(entry, [undefined]);
		expect(broadcasts).toEqual([true]);
		await handingOff;
	});

	test("a failed handoff republishes the cleared compacting state", async () => {
		// A thrown call skips the post-mutation resync; without this the browser
		// kept "Compaction in progress…" up after the failure.
		const session = {
			isCompacting: false,
			handoff: async () => {
				session.isCompacting = true;
				await Promise.resolve();
				session.isCompacting = false;
				throw new Error("Nothing to hand off (no messages yet)");
			},
		};
		const entry = { session } as unknown as SessionEntry;
		broadcasts.length = 0;
		await expect(tables.methods.handoff!(entry, [undefined])).rejects.toThrow(
			"Nothing to hand off",
		);
		expect(broadcasts).toEqual([true, false]);
	});
});

function btwEntry(artifactsDir: string | null): SessionEntry {
	const sessionManager = { getArtifactsDir: () => artifactsDir };
	const session = { sessionId: "sess-btw", sessionManager };
	return { handle: "s1", session } as unknown as SessionEntry;
}

describe("download manifest BTW history", () => {
	test("BTW records under the session's artifacts dir are listed and marked included", async () => {
		const artifactsDir = tempDir("omp-methods-btw-artifacts-");
		const scopeDir = join(artifactsDir, "btw-history", "sessions", "sess-btw");
		mkdirSync(scopeDir, { recursive: true });
		writeFileSync(join(scopeDir, "rec.json"), "{}");
		const manifest = (await methodsTable().downloadManifest!(btwEntry(artifactsDir), [
			{ includeAdvisor: false, includeBtw: true, includeWorkers: false },
		])) as DownloadManifestResult;
		expect(manifest).toMatchObject({ btwIncluded: true });
		expect(manifest.files).toContainEqual(
			expect.objectContaining({ name: "btw-history/rec.json", kind: "btw" }),
		);
		expect(manifest.warnings).not.toContain(
			"BTW history location is unavailable; no BTW history can be included.",
		);
	});

	test("a session with no artifacts dir omits BTW with a warning instead of failing", async () => {
		const manifest = (await methodsTable().downloadManifest!(btwEntry(null), [
			{ includeAdvisor: false, includeBtw: true, includeWorkers: false },
		])) as DownloadManifestResult;
		expect(manifest).toMatchObject({ btwIncluded: false });
		expect(manifest.warnings).toContain(
			"BTW history location is unavailable; no BTW history can be included.",
		);
	});

	test("an artifacts dir with no BTW scope directory lists nothing and does not throw", async () => {
		const artifactsDir = tempDir("omp-methods-btw-empty-");
		const manifest = (await methodsTable().downloadManifest!(btwEntry(artifactsDir), [
			{ includeAdvisor: false, includeBtw: true, includeWorkers: false },
		])) as DownloadManifestResult;
		expect(manifest).toMatchObject({ btwIncluded: false });
		expect(manifest.files.filter((file) => file.kind === "btw")).toEqual([]);
	});
});

describe("READ_ONLY classification", () => {
	// Methods that change session state, write to disk, or start model work. Every
	// other method must be classified read-only so a call does not trigger a state resync.
	const MUTATING: Record<string, true> = {
		abort: true,
		abortBash: true,
		abortCompaction: true,
		abortEval: true,
		advisorConfigure: true,
		annotationCompose: true,
		annotationCreate: true,
		annotationRemove: true,
		applyModelPreset: true,
		bash: true,
		btwCancel: true,
		btwFollowUp: true,
		btwInject: true,
		btwStart: true,
		cancelJob: true,
		clearModelRole: true,
		clearQueue: true,
		deleteModelPreset: true,
		dropImages: true,
		exportDownload: true,
		followUp: true,
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
		login: true,
		loopCancel: true,
		loopPause: true,
		loopResume: true,
		loopStart: true,
		mcpAdd: true,
		mcpDisable: true,
		mcpEnable: true,
		mcpOAuthRevoke: true,
		mcpReconnect: true,
		mcpRemove: true,
		mcpUpdate: true,
		planDecide: true,
		planGet: true,
		planReopen: true,
		popLastQueuedMessage: true,
		predictNextMessage: true,
		prompt: true,
		python: true,
		queueCommand: true,
		queueCompaction: true,
		reloadIntegrations: true,
		resumeDelete: true,
		resumeQueue: true,
		retry: true,
		runQueuedCommandNow: true,
		runQueuedNow: true,
		saveModelPreset: true,
		setAutoCompaction: true,
		setAutoRetry: true,
		setFastMode: true,
		setModelRole: true,
		setModelRoleHidden: true,
		setPlanModeState: true,
		setPluginEnabled: true,
		setPluginFeatures: true,
		setPluginSetting: true,
		setSetting: true,
		setSkillEnabled: true,
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

	test("btwInject sends a user message, so it is a readiness-gated mutation", () => {
		const web = webMethods();
		expect(web.notReadyGated).toHaveProperty("btwInject");
		expect(web.readOnly).not.toHaveProperty("btwInject");
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

	test("getToolSchemas with brief answers names and cut descriptions, no schemas", async () => {
		const tools = [
			{
				name: "read",
				description: "r".repeat(500),
				parameters: { type: "object", properties: { path: { type: "string" } } },
				examples: [{ title: "x" }],
			},
		];
		const entry = { session: { agent: { state: { tools } } } } as unknown as SessionEntry;
		const result = await methodsTable().getToolSchemas!(entry, [{ brief: true }]);
		expect(result).toEqual([
			{ name: "read", description: "r".repeat(TOOL_BRIEF_DESCRIPTION_CHARS) },
		]);
	});
});
