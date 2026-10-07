import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { getAvailableThemes, type Settings } from "@oh-my-pi/pi-coding-agent";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { cfgModelRoleStorage, cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { lookup } from "@oh-my-pi/pi-coding-agent/config/registry";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { resolveRoleModelFull } from "@oh-my-pi/pi-coding-agent/session/role-models";
import { cfgComputerEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";
import type { WebMethodName } from "#lib/wire/protocol";
import type { CollabSession, Images } from "./collab-session";
import type { DaemonBroker } from "./daemon-broker";
import type { SessionEntry } from "./session-entry";
import { buildSettingsModel, coerceSettingValue } from "#lib/sdk-settings/settings-model";
import { applySettingSideEffects } from "./settings-effects";
import { resolveSessionMainFile, MaterializeSessionError } from "./session-materialize";
import os from "node:os";
import { createDownloadMethods } from "./download-manifest";
import { createResumeImportHandlers } from "./resume-import-adapter";
import { listWorkers, parkWorker, resumeWorker, reviveWorker } from "./worker-lifecycle";
import {
	getAdvisorOverview,
	getAdvisorStats,
	getAdvisorWarnings,
	setAdvisorEnabled,
} from "./advisor-service";
import {
	getAdvisorConfiguration,
	getAdvisorSettings,
	setAdvisorConfiguration,
	setAdvisorSettings,
} from "./advisor-config";
import { readAdvisorHistory } from "./advisor-history";
import {
	cancelLoop,
	createGoal,
	dropGoal,
	getLoopPolicy,
	pauseGoal,
	pauseLoop,
	previewLoop,
	replaceGoal,
	resumeGoal,
	resumeLoop,
	setBudget,
	startLoop,
} from "./goal-service";
import {
	getVibeState,
	killAllVibeWorkers,
	killVibeWorker,
	rehydrateVibeWorkers,
	sendVibeWorker,
	setVibeMode,
	spawnVibeWorker,
	waitVibeWorkers,
} from "./vibe-service";
import { createVoiceAdapter, type VoiceAdapter } from "./voice-adapter";
import { serviceFor } from "./btw-history-adapter";
import { cfgSttEnabled } from "@oh-my-pi/pi-coding-agent/stt/settings";
import {
	abortCompactionRun,
	compactionSnapshot,
	executeCompaction,
	executeDropImages,
	executeShake,
	handoffPreview,
} from "./compaction-adapter";
import { createLifecycleMethods } from "./lifecycle-adapter";
import { createSettingsMethods } from "./settings-methods";
import { rejectEntryUiRequests } from "./ui-context";
import { createAnnotationMethods } from "./review-annotations";
import { createGitReviewMethods } from "./review-git";
import { createPlanReviewMethods } from "./review-plan";
import { createTodoMethods } from "./review-todos";
import { createIntegrationMethods } from "./integrations-methods";
import {
	broadcast,
	broadcastTo,
	clearEphemeralAbort,
	ephemeralAborts,
	setEphemeralAbort,
} from "./sse-delivery";
import {
	clearSubagents,
	readSubagentTranscript,
	resolveSubagentSessionFile,
} from "./subagent-mirror";

// ---------------------------------------------------------------------------
// Model-role picker helpers (TUI model-hub parity).
// ---------------------------------------------------------------------------

// Role-id validation shared by the roles-picker mutations; matches the TUI
// model-hub custom-role regex.
const MODEL_ROLE_ID_RE = /^[a-zA-Z][\w-]*$/;

function assertModelRoleId(role: string): void {
	if (!MODEL_ROLE_ID_RE.test(role)) {
		throw new Error(`Invalid model role: ${role}`);
	}
}

/** Concrete thinking selectors accepted by setModelRole (excludes the "auto" sentinel). */
const THINKING_LEVEL_VALUES = Object.values(ThinkingLevel);

/**
 * The session's currently active role per the same cycle order the daemon
 * broker's state snapshot uses: built-in roles in canonical order, then
 * custom roles from settings. Undefined when no role cycle resolves.
 */
function activeRoleOf(session: AgentSession): string | undefined {
	const customRoles = Object.keys(session.settings.getModelRoles()).filter(
		(role) => !(MODEL_ROLE_IDS as readonly string[]).includes(role),
	);
	const cycle = session.getRoleModelCycle([...MODEL_ROLE_IDS, ...customRoles]);
	return cycle?.models[cycle.currentIndex]?.role;
}

// ---------------------------------------------------------------------------
// The METHODS dispatch table: every WebMethodName the POST /command `call`
// route can invoke. Rows are closures over the session entry; the boot-local
// settings/authStorage singletons and the collab-session / daemon-broker
// surfaces are injected at construction. The dispatch core itself (routing,
// readiness gate, resync, login special-casing) lives in apps/session/index.ts.
// ---------------------------------------------------------------------------

export interface WebMethodsDeps {
	settings: Settings;
	authStorage: AuthStorage;
	collab: CollabSession;
	broker: DaemonBroker;
	/** P8.9 wake: materialize a session's stored transcripts from the fleet
	 * log store into the agent sessions dir (wired by apps/session/index.ts). */
	materializeSession: (
		entry: SessionEntry,
		args: { sessionId?: string },
	) => Promise<{ files: number; bytes: number } | { alreadyPresent: true }>;
	/** Agent sessions root the daemon writes into (boot-time constant). */
	sessionsDir: string;
	/** Daemon bound cwd (resume scoping); entry.cwd matches it on this daemon. */
	cwd: string;
	/** True when a fleet callback pair is active (clone workspaces). A live
	 * pair is the ONLY way a bare session id can be resolved against the
	 * fleet store; without it, switchSession keeps its path semantics. */
	hasCallbackPair: () => boolean;
}

export interface WebMethods {
	methods: Partial<
		Record<
			WebMethodName,
			(entry: SessionEntry, args: unknown[], streamId?: number) => Promise<unknown>
		>
	>;
	readOnly: Partial<Record<WebMethodName, true>>;
	notReadyGated: Partial<Record<WebMethodName, true>>;
	historyReload: Partial<Record<WebMethodName, true>>;
	getInFlightBash(): number;
	getInFlightPython(): number;
}

export function createWebMethods(deps: WebMethodsDeps): WebMethods {
	/** In-flight user bash/python calls (idle suppression, R11); wrapper counters
	 *  around METHODS rows. */
	let inFlightBash = 0;
	let inFlightPython = 0;

	// Per-entry voice adapters: discovery reads live settings, STT uses the
	// session model registry, deltas emit as SSE frames on the entry handle.
	const voiceAdapters = new WeakMap<SessionEntry, VoiceAdapter>();
	const voiceAdapter = (entry: SessionEntry): VoiceAdapter => {
		const cached = voiceAdapters.get(entry);
		if (cached) return cached;
		const created = createVoiceAdapter({
			sttDependencies: {
				settings: deps.settings,
				registry: entry.session.modelRegistry,
			},
			discovery: () => ({
				sttEnabled: cfgSttEnabled.get(deps.settings),
				toolsEnabled: true,
				liveAuthPresent: false,
			}),
			emit: (frame) => broadcastTo(entry.handle, frame),
		});
		voiceAdapters.set(entry, created);
		return created;
	};

	// Read-only calls skip the post-mutation state broadcast.
	const READ_ONLY: Partial<Record<WebMethodName, true>> = {
		getSessionStats: true,
		getAvailableModels: true,
		getSettings: true,
		getBranchMessages: true,
		getQueuedMessages: true,
		getLoginProviders: true,
		getSubagents: true,
		getSubagentMessages: true,
		formatSessionAsText: true,
		dumpLlmRequestToTmpDir: true,
		fetchUsageReports: true,
		getContextBreakdown: true,
	};

	// Readiness gate (R8): before the boot session's provider/model/auth
	// resolution completes, prompt-family methods fail with a not_ready error
	// instead of failing obscurely against a half-built session.
	const NOT_READY_GATED: Partial<Record<WebMethodName, true>> = {
		prompt: true,
		steer: true,
		followUp: true,
		abortAndPrompt: true,
		runEphemeralTurn: true,
	};

	// Calls that replace the transcript; every tab resyncs, not just the requester.
	// Handoff compacts in place; every replacement/rewind resyncs all tabs.
	const HISTORY_RELOAD: Partial<Record<WebMethodName, true>> = {
		newSession: true,
		switchSession: true,
		branch: true,
		fork: true,
		handoff: true,
		clearSession: true,
		deleteSession: true,
		navigateTree: true,
		resumeAfterAskReanswer: true,
		btwPromote: true,
	};

	async function changeSession(
		entry: SessionEntry,
		kind: "newSession" | "switchSession" | "branch",
		arg: string | undefined,
	): Promise<unknown> {
		const { session } = entry;
		if (kind === "newSession") {
			const ok = await session.newSession(arg ? { parentSession: arg } : undefined);
			if (ok) {
				clearSubagents(entry);
				await deps.broker.broadcastAvailableCommands(entry);
			}
			return { cancelled: !ok };
		}
		if (kind === "switchSession") {
			// P8.4/P8.9: a READY clone's dropdown sends the session ID (the
			// fleet store key: path=id=sessionId), not a file path. The SDK
			// switchSession treats a non-existent path as "start fresh at
			// that path", which is the "only New session" defect. Resolve a
			// bare id (slash-free, non-.jsonl, not an existing file) against
			// the fleet store FIRST: materialize-if-cold via the callback
			// pair, then switch to the resolved main JSONL. Only when a pair
			// is active; direct/worktree daemons pass real paths and keep
			// the SDK path semantics unchanged.
			const target = await resolveSwitchSessionTarget(entry, arg);
			const ok = await session.switchSession(target);
			if (ok) {
				clearSubagents(entry);
				await deps.broker.broadcastAvailableCommands(entry);
			}
			return { cancelled: !ok };
		}
		const result = await session.branch(arg as string);
		if (!result.cancelled) {
			clearSubagents(entry);
			await deps.broker.broadcastAvailableCommands(entry);
		}
		return { text: result.selectedText, cancelled: result.cancelled };
	}

	/**
	 * Resolve a switchSession argument to a real main JSONL path. Real
	 * .jsonl file paths (worktree/direct dropdown picks, TUI) pass through
	 * unchanged. A bare session id is resolved only when a fleet callback
	 * pair is active (clone workspaces): materialize the session's stored
	 * transcripts if cold, then locate its main file under the sessions
	 * root. A store miss surfaces as typed `unavailable` (the membership
	 * rejection, never a silent fresh session).
	 */
	async function resolveSwitchSessionTarget(
		entry: SessionEntry,
		arg: string | undefined,
	): Promise<string> {
		const raw = arg ?? "";
		if (raw === "") {
			throw new Error("switchSession requires a session file path or session id");
		}
		const looksLikePath =
			raw.includes("/") ||
			raw.includes("\\") ||
			raw.endsWith(".jsonl") ||
			raw.startsWith(".") ||
			raw.startsWith("-");
		if (looksLikePath || !deps.hasCallbackPair()) {
			// Real path (worktree/direct) or no store to resolve against:
			// keep the SDK's path semantics.
			return raw;
		}
		// A bare id: verify membership against the local tree OR the fleet
		// store, materializing when cold. materializeSession throws typed
		// `unavailable` when the fleet lacks the session (the membership
		// boundary); a warm volume makes it a no-op.
		await deps.materializeSession(entry, { sessionId: raw });
		const mainFile = resolveSessionMainFile(deps.sessionsDir, raw);
		if (mainFile === null) {
			throw new MaterializeSessionError(
				"unavailable",
				`session ${raw} has no transcript on this workspace or in the fleet store`,
			);
		}
		return mainFile;
	}

	const METHODS: Partial<
		Record<
			WebMethodName,
			(entry: SessionEntry, args: unknown[], streamId?: number) => Promise<unknown>
		>
	> = {
		prompt: async (entry, a) => {
			const text = a[0] as string;
			const images = a[1] as Images;
			if (await deps.collab.runBuiltinSlashCommand(entry, text, images)) return undefined;
			deps.collab.fireAndForgetPrompt(entry, text, images);
			return undefined;
		},
		steer: (entry, a) => entry.session.steer(a[0] as string, a[1] as Images),
		followUp: (entry, a) => entry.session.followUp(a[0] as string, a[1] as Images),
		getQueuedMessages: async (entry) => entry.session.getQueuedMessages(),
		popLastQueuedMessage: async (entry) => entry.session.popLastQueuedMessage(),
		clearQueue: async (entry) => entry.session.clearQueue(),
		abort: (entry) => entry.session.abort({ reason: USER_INTERRUPT_LABEL }),
		abortAndPrompt: async (entry, a) => {
			await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
			deps.collab.fireAndForgetPrompt(entry, a[0] as string, a[1] as Images);
		},
		// newSession/clearSession/freshSession/deleteSession land via the lifecycle spread below.
		switchSession: (entry, a) => changeSession(entry, "switchSession", a[0] as string),
		branch: (entry, a) => changeSession(entry, "branch", a[0] as string),
		compact: (entry, a) => entry.session.compact(a[0] as string | undefined),
		retry: (entry) => entry.session.retry(),
		fork: (entry) => entry.session.fork(),
		handoff: (entry, a) => entry.session.handoff(a[0] as string | undefined),
		setSessionName: (entry, a) => entry.session.setSessionName(a[0] as string, "user"),
		setInterruptMode: async (entry, a) => {
			entry.session.setInterruptMode(a[0] as "immediate" | "wait");
		},
		// Phase 9 (SDK 18.2.6): /goal and /plan are NOT ACP-intercepted server-side, so
		// goal/plan control drives the SDK directly. The post-mutation state
		// broadcast re-reads getGoalModeState()/getPlanModeState()?.enabled.
		setGoalModeState: async (entry, a) => {
			entry.session.setGoalModeState(a[0] as GoalModeState | undefined);
		},
		setPlanModeState: async (entry, a) => {
			entry.session.setPlanModeState(a[0] as PlanModeState | undefined);
		},
		// Goal runtime owns consent, budgets, and exclusion guards (goal-service).
		goalCreate: (entry, a) =>
			createGoal(entry, {
				objective: String((a[0] as { objective?: unknown }) ?? a[0] ?? ""),
				...(typeof a[0] === "object" && a[0] !== null
					? (a[0] as { tokenBudget?: number; consent?: boolean })
					: { consent: true }),
			}),
		goalReplace: (entry, a) =>
			replaceGoal(entry, {
				objective: String(a[0] ?? ""),
				...(typeof a[1] === "object" && a[1] !== null
					? (a[1] as { tokenBudget?: number; consent?: boolean })
					: {}),
			}),
		goalBudget: (entry, a) => setBudget(entry, typeof a[0] === "number" ? a[0] : undefined),
		goalPause: (entry) => pauseGoal(entry),
		goalResume: (entry, a) =>
			resumeGoal(
				entry,
				typeof a[0] === "object" && a[0] !== null ? (a[0] as { consent?: boolean }) : undefined,
			),
		goalDrop: (entry) => dropGoal(entry),
		formatSessionAsText: async (entry) => entry.session.formatSessionAsText(),
		// Dump lands in os.tmpdir(), already inside the /download realpath jail.
		dumpLlmRequestToTmpDir: (entry) => entry.session.dumpLlmRequestToTmpDir(),
		setModel: async (entry, a) => {
			const { session } = entry;
			const [provider, modelId] = [a[0] as string, a[1] as string];
			let model = session
				.getAvailableModels()
				.find((m) => m.provider === provider && m.id === modelId);
			if (!model) {
				// Cold start: discovery-backed providers populate seconds after
				// session ready; wait for in-flight discovery before giving up.
				await session.modelRegistry.awaitBackgroundRefresh();
				model = session
					.getAvailableModels()
					.find((m) => m.provider === provider && m.id === modelId);
			}
			if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
			await session.setModel(model);
			return model;
		},
		cycleModel: async (entry) => (await entry.session.cycleModel()) ?? null,
		// Model-roles picker (TUI model-hub parity). All three are mutations:
		// none sit in READ_ONLY (the post-mutation broadcast refreshes state,
		// incl. the catalog) and, like setModel, none are readiness-gated or
		// transcript reloads. Persistence scope follows `modelRoleStorage`;
		// a changed role applies live only when it is the session's active role.
		setModelRole: async (entry, a) => {
			const { session } = entry;
			const role = String(a[0] ?? "");
			assertModelRoleId(role);
			const provider = String(a[1]);
			const modelId = String(a[2]);
			// `auto` cannot round-trip through a baked `provider/model:level`
			// role value, so reject it (the TUI persists it via
			// defaultThinkingLevel instead). "inherit"/undefined → no explicit
			// thinking baked in.
			const rawLevel = a[3];
			let level: ThinkingLevel | undefined;
			if (rawLevel !== undefined) {
				const asString = String(rawLevel);
				if (asString === "auto") {
					throw new Error(
						"Thinking level 'auto' cannot be baked into a role value; pick a concrete level or 'inherit'",
					);
				}
				if (!(THINKING_LEVEL_VALUES as readonly string[]).includes(asString)) {
					throw new Error(`Invalid thinking level: ${asString}`);
				}
				level = asString === ThinkingLevel.Inherit ? undefined : (asString as ThinkingLevel);
			}
			let model = session
				.getAvailableModels()
				.find((m) => m.provider === provider && m.id === modelId);
			if (!model) {
				// Cold start: discovery-backed providers populate seconds after
				// session ready; wait for in-flight discovery before giving up
				// (mirrors setModel).
				await session.modelRegistry.awaitBackgroundRefresh();
				model = session
					.getAvailableModels()
					.find((m) => m.provider === provider && m.id === modelId);
			}
			if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
			const settings = session.settings;
			const targetScope = cfgModelRoleStorage.get(settings) === "project" ? "project" : "global";
			const selector = `${model.provider}/${model.id}`;
			if (role === "default") {
				const { switched } = await session.setModel(model, "default", {
					thinkingLevel: level,
					persist: targetScope === "global",
				});
				if (!switched) return { role, provider: model.provider, id: model.id };
				if (targetScope === "project") {
					settings.setProjectModelRole("default", formatModelSelectorValue(selector, level));
				}
				return { role, provider: model.provider, id: model.id };
			}
			const modelRoleValue = formatModelSelectorValue(selector, level);
			if (targetScope === "project") {
				settings.setProjectModelRole(role, modelRoleValue);
			} else {
				settings.setModelRole(role, modelRoleValue);
			}
			// Apply live when the changed role is the session's active role.
			if (activeRoleOf(session) === role) {
				const resolved = resolveRoleModelFull(
					settings,
					role,
					session.getAvailableModels(),
					session.model,
				);
				if (resolved.model) {
					await session.applyRoleModel({
						role,
						model: resolved.model,
						thinkingLevel: resolved.thinkingLevel,
						explicitThinkingLevel: resolved.explicitThinkingLevel,
					});
				}
			}
			return { role, provider: model.provider, id: model.id };
		},
		clearModelRole: async (entry, a) => {
			const { session } = entry;
			const role = String(a[0] ?? "");
			assertModelRoleId(role);
			const settings = session.settings;
			const targetScope = cfgModelRoleStorage.get(settings) === "project" ? "project" : "global";
			// Capture the active role before clearing, since an unassigned role drops
			// out of the cycle entirely, so the post-clear cycle can't name it.
			const wasActive = activeRoleOf(session) === role;
			if (targetScope === "project") {
				settings.clearProjectModelRole(role);
			} else {
				settings.setModelRole(role, undefined);
			}
			if (!wasActive) return { role };
			// The cleared role re-resolves from the newly exposed persisted
			// layer; apply the effective value live when one resolves (setModel
			// for default, applyRoleModel otherwise, as in TUI onUnassign
			// semantics).
			const resolved = resolveRoleModelFull(
				settings,
				role,
				session.getAvailableModels(),
				session.model,
			);
			if (!resolved.model) return { role };
			if (role === "default") {
				await session.setModel(resolved.model, "default", {
					persist: false,
					thinkingLevel:
						resolved.explicitThinkingLevel && resolved.thinkingLevel !== "auto"
							? resolved.thinkingLevel
							: undefined,
				});
			} else {
				await session.applyRoleModel({
					role,
					model: resolved.model,
					thinkingLevel: resolved.thinkingLevel,
					explicitThinkingLevel: resolved.explicitThinkingLevel,
				});
			}
			return { role };
		},
		setModelRoleHidden: async (entry, a) => {
			const role = String(a[0] ?? "");
			assertModelRoleId(role);
			const hidden = a[1] === true;
			const settings = entry.session.settings;
			const tags = cfgModelTags.get(settings);
			// modelTags is a global-layer setting: persist globally, and the
			// picker filters hidden roles client-side while they stay functional.
			cfgModelTags.set(settings, { ...tags, [role]: { ...tags[role], hidden } });
			return { role, hidden };
		},
		getAvailableModels: async (entry) => {
			await entry.session.modelRegistry.awaitBackgroundRefresh();
			return entry.session.getAvailableModels();
		},
		setThinkingLevel: async (entry, a) => {
			entry.session.setThinkingLevel(a[0] as ThinkingLevel);
		},
		cycleThinkingLevel: async (entry) => {
			const level = entry.session.cycleThinkingLevel();
			return level ? { level } : null;
		},
		setSteeringMode: async (entry, a) => {
			entry.session.setSteeringMode(a[0] as "all" | "one-at-a-time");
		},
		setFollowUpMode: async (entry, a) => {
			entry.session.setFollowUpMode(a[0] as "all" | "one-at-a-time");
		},
		setAutoCompaction: async (entry, a) => {
			entry.session.setAutoCompactionEnabled(a[0] as boolean);
		},
		setAutoRetry: async (entry, a) => {
			entry.session.setAutoRetryEnabled(a[0] as boolean);
		},
		abortRetry: async (entry) => {
			entry.session.abortRetry();
		},
		setFastMode: async (entry, a) => {
			entry.session.setFastMode(a[0] as boolean);
		},
		// 18.1.9 turned computer use into an eval prelude gated by the
		// session-scoped `computer.enabled` setting (the SDK's own /computer
		// toggle), so this drives that override and rebuilds the prompt. The
		// availability guard mirrors applyComputerUseToggle (builtin-modes.ts):
		// the prelude only exists while the eval tool is active, so enabling it
		// without one must revert and refuse rather than answer a success that
		// nothing applied.
		setComputerToolEnabled: async (entry, a) => {
			const { session } = entry;
			const enabled = a[0] === true;
			const previous = cfgComputerEnabled.get(session.settings);
			cfgComputerEnabled.override(session.settings, enabled);
			if (
				enabled &&
				!session.getEvalPreludes().some((definition) => definition.name === "computer")
			) {
				cfgComputerEnabled.override(session.settings, previous);
				throw new Error("computer use is unavailable in this session");
			}
			try {
				await session.refreshBaseSystemPrompt();
			} catch (error) {
				cfgComputerEnabled.override(session.settings, previous);
				throw error;
			}
		},
		// 18.1.9 removed the inspect_image tool (`read <image>?q=` owns image
		// questions), so there is no session-scoped vision mode left to set. The
		// wire method stays (OMP_PROTO 2 is frozen) and fails loudly rather than
		// reporting a success nothing applied.
		setInspectImageMode: () => {
			throw new Error(
				"setInspectImageMode is unsupported: @oh-my-pi/pi-coding-agent 18.1.9 removed the inspect_image tool",
			);
		},
		// READ_ONLY rows: usage reports + context breakdown (skip the state broadcast).
		fetchUsageReports: (entry) => entry.session.fetchUsageReports(),
		getContextBreakdown: async (entry) => entry.session.getContextBreakdown(),
		// Phase 10: onChunk relays live output as session-scoped chunk frames
		// (streamId = the client's bash-item id). `!!`/`$$` dimmed variants are
		// excluded from the agent's context, matching the TUI semantic.
		// In-flight counters feed the idle auto-exit check (R11).
		bash: (entry, a, streamId) => {
			inFlightBash++;
			return entry.session
				.executeBash(
					a[0] as string,
					(chunk) => {
						if (streamId !== undefined)
							broadcastTo(entry.handle, { type: "bash_chunk", id: streamId, text: chunk });
					},
					{ excludeFromContext: a[1] === true },
				)
				.finally(() => {
					inFlightBash--;
				});
		},
		abortBash: async (entry) => {
			entry.session.abortBash();
		},
		python: (entry, a, streamId) => {
			inFlightPython++;
			return entry.session
				.executePython(
					a[0] as string,
					(chunk) => {
						if (streamId !== undefined)
							broadcastTo(entry.handle, { type: "python_chunk", id: streamId, text: chunk });
					},
					{ excludeFromContext: a[1] === true },
				)
				.finally(() => {
					inFlightPython--;
				});
		},
		abortEval: async (entry) => {
			entry.session.abortEval();
		},
		// Phase 11: /btw side question. runEphemeralTurn never touches the
		// transcript; onTextDelta relays as session-scoped ephemeral_delta frames
		// (streamId = the client's btw panel id), and the call resolves with the
		// final replyText. A per-streamId AbortController backs abortEphemeral.
		runEphemeralTurn: (entry, a, streamId) => {
			const controller = new AbortController();
			if (streamId !== undefined) setEphemeralAbort(entry, streamId, controller);
			return entry.session
				.runEphemeralTurn({
					promptText: String(a[0] ?? ""),
					signal: controller.signal,
					onTextDelta: (chunk) => {
						if (streamId !== undefined)
							broadcastTo(entry.handle, { type: "ephemeral_delta", id: streamId, text: chunk });
					},
				})
				.then(
					(result) => {
						if (streamId !== undefined) clearEphemeralAbort(entry, streamId);
						return { replyText: result.replyText };
					},
					(err) => {
						if (streamId !== undefined) clearEphemeralAbort(entry, streamId);
						throw err;
					},
				);
		},
		abortEphemeral: async (entry, _a, streamId) => {
			if (streamId === undefined) return;
			ephemeralAborts.get(entry)?.get(streamId)?.abort();
		},
		getSessionStats: async (entry) => entry.session.getSessionStats(),
		exportHtml: async (entry, a) => ({
			path: await entry.session.exportToHtml(a[0] ? String(a[0]) : undefined, a[1] === true),
		}),
		getBranchMessages: async (entry) => entry.session.getUserMessagesForBranching(),
		getLoginProviders: async () =>
			getOAuthProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				available: provider.available,
				authenticated:
					deps.authStorage.keys.source(provider.storeCredentialsAs ?? provider.id) !== undefined,
			})),
		login: () => Promise.reject(new Error("login is handled per-socket")),
		getSubagents: async (entry) => {
			// Roster from the per-session lifecycle mirror (task subagents register in
			// AgentRegistry.global(), not the private registry), enriched with live
			// registry data when the global ref still exists.
			return [...entry.subagentSnapshots.values()].map((snap) => {
				const ref = AgentRegistry.global().get(snap.id);
				return {
					id: snap.id,
					index: snap.index,
					agent: snap.agent ?? ref?.displayName ?? "agent",
					description: snap.description,
					task: snap.task,
					status: snap.status ?? ref?.status,
					lastUpdate: snap.lastUpdate,
					sessionFile: snap.sessionFile ?? ref?.sessionFile,
				};
			});
		},
		getSubagentMessages: (entry, a) => {
			const selector = a[0] as {
				subagentId?: string;
				sessionFile?: string;
				fromByte?: number;
				maxBytes?: number;
			};
			return readSubagentTranscript(
				resolveSubagentSessionFile(entry, selector),
				selector.fromByte,
				selector.maxBytes,
			);
		},
		subagentSteer: async (entry, a) => {
			await deps.collab.liveSubagentSession(entry, a[0] as string, "steer").steer(a[1] as string);
		},
		subagentAbort: async (entry, a) => {
			await deps.collab.abortSubagent(entry, a[0] as string);
		},
		// P8.9 wake: materialize a cold/missing session's stored lineage from
		// the fleet log store into the agent sessions dir, then return so the
		// caller can resume. Rows that need the fleet pair + agent dir are
		// injected by apps/session/index.ts after boot (this row is a proxy for the
		// real implementation, see apps/session/session-materialize.ts).
		materializeSession: (entry, a) =>
			deps.materializeSession(entry, a[0] as { sessionId?: string }),
		...createLifecycleMethods({
			sessionsDir: deps.sessionsDir,
			hasCallbackPair: deps.hasCallbackPair,
			assertWritable: async (entry) => {
				if (entry.session.sessionFile == null || !entry.session.sessionFile.endsWith(".jsonl"))
					throw new Error("Session lifecycle refused: no persisted file-backed session");
			},
			settleHostWork: async (entry) => {
				rejectEntryUiRequests(entry, "session lifecycle boundary");
				for (const controller of ephemeralAborts.get(entry)?.values() ?? []) controller.abort();
			},
			settleWorkers: async (entry) => {
				for (const id of entry.subagentSnapshots.keys()) {
					await deps.collab.abortSubagent(entry, id).catch(() => {});
				}
			},
			broadcastAvailableCommands: (entry) => deps.broker.broadcastAvailableCommands(entry),
		}),
		...createSettingsMethods({
			settings: deps.settings,
			getThemes: getAvailableThemes,
			broadcast: (model) => broadcast({ type: "settings_changed", model }),
		}),
		...createAnnotationMethods(),
		...createGitReviewMethods(),
		...createPlanReviewMethods(),
		...createTodoMethods(),
		...createIntegrationMethods({
			broadcastState: (entry) => deps.broker.broadcastState(entry),
			broadcastAvailableCommands: (entry) => deps.broker.broadcastAvailableCommands(entry),
		}).methods,
		...createDownloadMethods({
			manifestDeps: (entry) => ({
				sessionId: entry.session.sessionId,
				...(entry.session.sessionFile ? { sessionFile: entry.session.sessionFile } : {}),
				sessionsDir: deps.sessionsDir,
				subagentSessionFiles: entry.transcriptSessionFilesBySubagentId,
				subagentSnapshots: entry.subagentSnapshots,
			}),
			roots: () => [deps.sessionsDir, os.tmpdir()],
		}),
		...Object.fromEntries(
			Object.entries(
				createResumeImportHandlers({ cwd: deps.cwd, sessionDir: deps.sessionsDir }),
			).map(([name, handler]) => [name, (_entry: SessionEntry, args: unknown[]) => handler(args)]),
		),
		compactionSnapshot: async (entry) => compactionSnapshot(entry.session),
		compactEx: async (entry, a) => {
			const input = (a[0] ?? {}) as { mode?: string; instructions?: string };
			const mode = input.mode === "remote" || input.mode === "snapcompact" ? input.mode : "soft";
			return executeCompaction(entry.session, {
				mode,
				...(typeof input.instructions === "string" ? { instructions: input.instructions } : {}),
			});
		},
		shake: async (entry, a) => {
			const input = (a[0] ?? {}) as { mode?: string };
			const mode = input.mode === "images" || input.mode === "thinking" ? input.mode : "elide";
			return executeShake(entry.session, mode);
		},
		dropImages: async (entry) => executeDropImages(entry.session),
		abortCompaction: async (entry, a) => {
			const reason = (a[0] as { reason?: unknown } | undefined)?.reason;
			return abortCompactionRun(entry.session, reason);
		},
		handoffPreview: async (entry, a) => {
			const focus = (a[0] as { focus?: unknown } | undefined)?.focus;
			return handoffPreview(entry.session, typeof focus === "string" ? focus : undefined);
		},
		voiceCapability: async (entry) => voiceAdapter(entry).capability(),
		voiceDictationStart: async (entry, a) => voiceAdapter(entry).dictationStart(a[0] as never),
		voiceDictationFrame: async (entry, a) => voiceAdapter(entry).dictationFrame(a[0] as never),
		voiceDictationCommit: async (entry, a) => voiceAdapter(entry).dictationCommit(a[0] as never),
		voiceDictationCancel: async (entry, a) => voiceAdapter(entry).dictationCancel(a[0] as never),
		voiceRealtimeStart: async (entry, a) => voiceAdapter(entry).realtimeStart(a[0] as never),
		voiceRealtimeFrame: async (entry, a) => voiceAdapter(entry).realtimeFrame(a[0] as never),
		voiceRealtimeInterrupt: async (entry, a) =>
			voiceAdapter(entry).realtimeInterrupt(a[0] as never),
		voiceRealtimeMute: async (entry, a) => voiceAdapter(entry).realtimeMute(a[0] as never),
		voiceRealtimeStop: async (entry, a) => voiceAdapter(entry).realtimeStop(a[0] as never),
		btwList: async (entry, a) => (await serviceFor(entry.session)).listBtwRecords(a[0] as never),
		btwSearch: async (entry, a) =>
			(await serviceFor(entry.session)).listBtwSearch(String(a[0] ?? ""), a[1] as never),
		btwPage: async (entry, a) =>
			(await serviceFor(entry.session)).pageBtwTurns(String(a[0]), a[1] as never, a[2] as never),
		btwStart: async (entry, a, streamId) => {
			const service = await serviceFor(entry.session);
			const record = await service.startBtwTurn(entry.session, String(a[0] ?? ""), {
				onDelta: (text) => {
					if (streamId !== undefined)
						broadcastTo(entry.handle, { type: "ephemeral_delta", id: streamId, text });
				},
			});
			return { record };
		},
		btwFollowUp: async (entry, a, streamId) => {
			const service = await serviceFor(entry.session);
			const record = await service.startBtwTurn(entry.session, String(a[1] ?? ""), {
				recordId: String(a[0]),
				onDelta: (text) => {
					if (streamId !== undefined)
						broadcastTo(entry.handle, { type: "ephemeral_delta", id: streamId, text });
				},
			});
			return { record };
		},
		btwCancel: async (entry, a) => ({
			record: await (await serviceFor(entry.session)).cancelBtwTurn(String(a[0])),
		}),
		btwCopy: async (entry, a) => ({
			text: (await serviceFor(entry.session)).copyBtwText(String(a[0])) ?? null,
		}),
		btwPromotePreview: async (entry, a) =>
			(await serviceFor(entry.session)).previewPromoteBtw(
				entry.session,
				entry.session.sessionManager,
				String(a[0]),
			),
		btwPromote: async (entry, a) =>
			(await serviceFor(entry.session)).promoteBtwToBranch(
				entry.session,
				entry.session.sessionManager,
				String(a[0]),
			),
		workerList: async (entry) => ({ workers: await listWorkers(entry) }),
		workerPark: async (entry, a) => parkWorker(entry, String(a[0])),
		workerRevive: async (entry, a) => reviveWorker(entry, String(a[0])),
		workerResume: async (entry, a) => resumeWorker(entry, String(a[0])),
		advisorGetStatus: async (entry, a) => {
			const section = (a[0] as { section?: string } | undefined)?.section;
			if (section === "stats") return getAdvisorStats(entry);
			if (section === "warnings") return getAdvisorWarnings(entry);
			if (section === "configuration") return getAdvisorConfiguration(entry, "project");
			return getAdvisorOverview(entry);
		},
		advisorConfigure: async (entry, a) => {
			const input = (a[0] ?? {}) as { enabled?: boolean; scope?: string; document?: unknown };
			if (typeof input.enabled === "boolean") return setAdvisorEnabled(entry, input.enabled);
			if (input.document !== undefined)
				return setAdvisorConfiguration(entry, {
					scope: input.scope === "user" ? "user" : "project",
					document: input.document,
				} as never);
			return setAdvisorSettings(entry, input as never);
		},
		advisorTranscript: async (entry, a) => readAdvisorHistory(entry, (a[0] ?? {}) as never),
		loopPreview: async (_entry, a) => previewLoop(String(a[0] ?? "")),
		loopPolicy: async (entry) => getLoopPolicy(entry),
		loopStart: async (entry, a) =>
			startLoop(entry, {
				argsText: String(a[0] ?? ""),
				...(typeof a[1] === "object" && a[1] !== null
					? (a[1] as { prompt?: string; consent?: boolean })
					: {}),
			}),
		loopPause: async (entry) => pauseLoop(entry),
		loopCancel: async (entry) => cancelLoop(entry),
		loopResume: async (entry, a) =>
			resumeLoop(
				entry,
				typeof a[0] === "object" && a[0] !== null ? (a[0] as { consent?: boolean }) : {},
			),
		vibeStatus: async (entry) => getVibeState(entry),
		vibeSetMode: async (entry, a) =>
			setVibeMode(
				entry,
				a[0] === true,
				typeof a[1] === "object" && a[1] !== null ? (a[1] as { consent?: boolean }) : undefined,
			),
		vibeSpawn: async (entry, a) => spawnVibeWorker(entry, (a[0] ?? {}) as never),
		vibeSend: async (entry, a) => sendVibeWorker(entry, (a[0] ?? {}) as never),
		vibeWait: async (entry, a) => waitVibeWorkers(entry, (a[0] ?? {}) as never),
		vibeKill: async (entry, a) => killVibeWorker(entry, String(a[0])),
		vibeKillAll: async (entry) => killAllVibeWorkers(entry),
		vibeRehydrate: async (entry) => rehydrateVibeWorkers(entry),
	};

	return {
		methods: METHODS,
		readOnly: READ_ONLY,
		notReadyGated: NOT_READY_GATED,
		historyReload: HISTORY_RELOAD,
		getInFlightBash: () => inFlightBash,
		getInFlightPython: () => inFlightPython,
	};
}
