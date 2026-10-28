import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getBlobsDir } from "@oh-my-pi/pi-utils";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { modelKind } from "@oh-my-pi/pi-catalog/types";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { getAvailableThemes, type Settings } from "@oh-my-pi/pi-coding-agent";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { cfgModelRoleStorage, cfgModelTags } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import {
	disabledProviderIds,
	getModelMatchPreferences,
	resolveCliModel,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { BlobStore } from "@oh-my-pi/pi-coding-agent/session/blob-store";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import {
	isUserAuthoredQueuedMessage,
	toRestoredQueuedMessage,
} from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { resolveRoleModelFull } from "@oh-my-pi/pi-coding-agent/session/role-models";
import { cfgTaskAgentModelOverrides } from "@oh-my-pi/pi-coding-agent/task/settings";
import type {
	ModelBrowserEntry,
	ModelLockReason,
	QueuedCommandRef,
	QueuedMessageRef,
	QueuedMessagesSnapshot,
	ToolBriefInfo,
	WebMethodName,
} from "#lib/wire/protocol";
import { READ_ONLY_METHODS, TOOL_BRIEF_DESCRIPTION_CHARS } from "#lib/wire/protocol";
import { oversizedImageNotice } from "#lib/wire/image-limits";
import type { CollabSession, Images } from "./collab-session";
import { removeQueuedCommand } from "./command-queue";
import type { DaemonBroker } from "./daemon-broker";
import { repinModelRole, retakeModelRolePin } from "./model-role-pin";
import type { SessionEntry } from "./session-entry";
import {
	dropHeldQueue,
	holdQueuedMessages,
	resumeHeldQueue,
	takeQueuedMessage,
} from "./queue-hold";
import { createPluginMethods } from "./plugin-methods";
import { resolveSessionMainFile, MaterializeSessionError } from "./session-materialize";
import os from "node:os";
import { createDownloadMethods } from "./download-manifest";
import { createResumeHandlers } from "./resume-adapter";
import { listWorkers, parkWorker, resolveTranscriptFile, reviveWorker } from "./worker-lifecycle";
import {
	getAdvisorOverview,
	getAdvisorStats,
	getAdvisorWarnings,
	setAdvisorEnabled,
} from "./advisor-service";
import { readAdvisorHistory } from "./advisor-history";
import { getAutonomyAdapter } from "./autonomy-adapter";
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
import { serviceFor } from "./btw-history-adapter";
import {
	abortCompactionRun,
	compactionSnapshot,
	executeCompaction,
	executeDropImages,
	executeShake,
} from "./compaction-adapter";
import { createLifecycleMethods, type LifecycleMirror } from "./lifecycle-adapter";
import { createComposerMethods } from "./composer-methods";
import { createSettingsMethods } from "./settings-methods";
import { cancelEntryUiRequests, rejectEntryUiRequests } from "./ui-context";
import { createAnnotationMethods } from "./review-annotations";
import { createGitReviewMethods } from "./review-git";
import { createPlanReviewMethods, exitPlanMode } from "./review-plan";
import { createTodoMethods } from "./review-todos";
import { createJobMethods } from "./job-methods";
import { createMcpMethods } from "./mcp-methods";
import { createSkillMethods } from "./skill-methods";
import { broadcast, broadcastHistory, broadcastTo } from "./client-delivery";
import { clearSubagents, readSubagentTranscript, subagentProgressFields } from "./subagent-mirror";
import { readSubagentImage } from "./subagent-image";
import {
	createGraphModelHandlers,
	type GraphNavigateOptions,
	type GraphQuery,
} from "./graph-model-adapter";
import { transcriptHistoryFrames } from "./transcript-history";

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
 * The session's currently active role per the same cycle order the session
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
// The METHODS dispatch table: every WebMethodName the `call` command
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
	/** Wake: materialize a session's stored transcripts from the fleet
	 * log store into the agent sessions dir (wired by apps/session/index.ts). */
	materializeSession: (
		entry: SessionEntry,
		args: { sessionId?: string },
	) => Promise<{ files: number; bytes: number } | { alreadyPresent: true }>;
	/** Blob store holding the sessions' externalized images; defaults to the agent directory's shared store. */
	blobStore?: BlobStore;
	/** Agent sessions root the session writes into (boot-time constant). */
	sessionsDir: string;
	/** Session bound cwd (resume scoping); entry.cwd matches it on this session. */
	cwd: string;
	/** True when a fleet callback pair is active (clone workspaces). A live
	 * pair is the ONLY way a bare session id can be resolved against the
	 * fleet store; without it, switchSession keeps its path semantics. */
	hasCallbackPair: () => boolean;
	/** Fleet mirror for acknowledged deletion; absent when no callback pair is active. */
	lifecycleMirror?: LifecycleMirror;
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
	nameOnly: Partial<Record<WebMethodName, true>>;
	getInFlightBash(): number;
	getInFlightPython(): number;
}

export function createWebMethods(deps: WebMethodsDeps): WebMethods {
	/** In-flight user bash/python calls (idle suppression, R11); wrapper counters
	 *  around METHODS rows. */
	let inFlightBash = 0;
	let inFlightPython = 0;
	/** Fire-and-forget state frame, for a mid-call change browsers must see before the answer. */
	const publishState = (entry: SessionEntry): void => {
		void deps.broker.broadcastState(entry).catch(() => {});
	};

	// Calls whose only state change is the session name. The SDK name listener
	// (collab-session.ts wireSession) already broadcasts that change, so these
	// skip the post-mutation state broadcast and a rename yields one state frame.
	const NAME_ONLY: Partial<Record<WebMethodName, true>> = {
		setSessionName: true,
		resumeRename: true,
	};

	// Readiness gate (R8): before the boot session's provider/model/auth
	// resolution completes, prompt-family methods fail with a not_ready error
	// instead of failing obscurely against a half-built session.
	const NOT_READY_GATED: Partial<Record<WebMethodName, true>> = {
		prompt: true,
		steer: true,
		followUp: true,
		resumeQueue: true,
		runQueuedNow: true,
		queueCommand: true,
		runQueuedCommandNow: true,
		predictNextMessage: true,
	};

	// Calls that replace the transcript; every tab resyncs, not just the requester.
	// Handoff, compaction, shake, and image drops rewrite the transcript in place; every rewrite resyncs all tabs.
	const HISTORY_RELOAD: Partial<Record<WebMethodName, true>> = {
		newSession: true,
		switchSession: true,
		branch: true,
		fork: true,
		handoff: true,
		compactEx: true,
		shake: true,
		dropImages: true,
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
		// A live room hosts this session's transcript; a session change ends it (guests get a bye).
		await deps.collab.stopRoom(entry, "session changed");
		const autonomy = getAutonomyAdapter(entry);
		await autonomy.beginSessionChange();
		try {
			return await swapTranscript(entry, kind, arg);
		} finally {
			// The SDK contract: new and switch stop the running agent; branch navigation does not.
			await autonomy.endSessionChange({ detachedRun: kind !== "branch" });
		}
	}

	async function swapTranscript(
		entry: SessionEntry,
		kind: "newSession" | "switchSession" | "branch",
		arg: string | undefined,
	): Promise<unknown> {
		const { session } = entry;
		if (kind === "newSession") {
			const ok = await session.newSession(arg ? { parentSession: arg } : undefined);
			if (ok) {
				retakeModelRolePin(session.settings);
				clearSubagents(entry);
				dropHeldQueue(entry);
				await deps.broker.broadcastAvailableCommands(entry);
			}
			return { cancelled: !ok };
		}
		if (kind === "switchSession") {
			// A READY clone's dropdown sends the session ID (the
			// fleet store key: path=id=sessionId), not a file path. The SDK
			// switchSession treats a non-existent path as "start fresh at
			// that path", which is the "only New session" defect. Resolve a
			// bare id (slash-free, non-.jsonl, not an existing file) against
			// the fleet store FIRST: materialize-if-cold via the callback
			// pair, then switch to the resolved main JSONL. Only when a pair
			// is active; direct/worktree sessions pass real paths and keep
			// the SDK path semantics unchanged.
			const target = await resolveSwitchSessionTarget(entry, arg);
			await exitPlanMode(entry);
			const ok = await session.switchSession(target);
			if (ok) {
				clearSubagents(entry);
				dropHeldQueue(entry);
				await deps.broker.broadcastAvailableCommands(entry);
			}
			return { cancelled: !ok };
		}
		const result = await session.branch(arg as string);
		if (!result.cancelled) {
			clearSubagents(entry);
			dropHeldQueue(entry);
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

	const plugins = createPluginMethods({ cwd: deps.cwd });
	const graph = createGraphModelHandlers({
		rebuildTranscript: (entry) =>
			broadcastHistory(entry.handle, transcriptHistoryFrames(entry.session)),
	});
	const settingsMethods = createSettingsMethods({
		settings: deps.settings,
		getThemes: getAvailableThemes,
		broadcast: (model) => broadcast({ type: "settings_changed", model }),
	});
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
			void deps.collab.fireAndForgetPrompt(entry, text, images);
			return undefined;
		},
		steer: (entry, a) => entry.session.steer(a[0] as string, a[1] as Images),
		followUp: (entry, a) => entry.session.followUp(a[0] as string, a[1] as Images),
		getQueuedMessages: async (entry): Promise<QueuedMessagesSnapshot> => {
			const live = entry.session.getQueuedMessages();
			const { agent } = entry.session;
			// Same filter and order as the SDK's chip texts, so each count lines up with its chip.
			const steeringImageCounts = [...agent.peekLiveSteeredMessages(), ...agent.peekSteeringQueue()]
				.filter(isUserAuthoredQueuedMessage)
				.map((message) => toRestoredQueuedMessage(message).images?.length ?? 0);
			const followUpImageCounts = agent
				.peekFollowUpQueue()
				.filter(isUserAuthoredQueuedMessage)
				.map((message) => toRestoredQueuedMessage(message).images?.length ?? 0);
			return {
				steering: [...live.steering],
				followUp: [...live.followUp],
				liveSteered: live.liveSteered,
				steeringImageCounts,
				followUpImageCounts,
				paused: entry.pausedQueue.map(({ kind, message }) => ({
					kind,
					text: message.text,
					imageCount: message.images?.length ?? 0,
				})),
				commands: entry.queuedCommands.commands.map((command) => command.text),
				commandImageCounts: entry.queuedCommands.commands.map(
					(command) => command.images?.length ?? 0,
				),
				commandsPaused: entry.queuedCommands.paused,
			};
		},
		popLastQueuedMessage: async (entry) =>
			entry.session.popLastQueuedMessage() ?? entry.pausedQueue.pop()?.message,
		clearQueue: async (entry) => {
			entry.pausedQueue.length = 0;
			entry.queuedCommands.commands.length = 0;
			return entry.session.clearQueue();
		},
		abort: async (entry) => {
			// Stop always cancels a pending ask, even when the SDK's signal never reaches it.
			cancelEntryUiRequests(entry);
			holdQueuedMessages(entry.session, entry.pausedQueue);
			// Stop also holds queued slash commands until Resume queue.
			entry.queuedCommands.paused = true;
			getAutonomyAdapter(entry).stopForHostAbort();
			await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
			for (const [id, snapshot] of entry.subagentSnapshots) {
				if (snapshot.status === "pending" || snapshot.status === "running") {
					await deps.collab.abortSubagent(entry, id).catch(() => {});
				}
			}
		},
		resumeQueue: async (entry) => {
			entry.queuedCommands.paused = false;
			const result = await resumeHeldQueue(entry.session, entry.pausedQueue);
			await deps.collab.drainCommands(entry);
			return result;
		},
		takeQueued: async (entry, a) =>
			takeQueuedMessage(entry.session, entry.pausedQueue, a[0] as QueuedMessageRef),
		queueCommand: async (entry, a) => {
			const images = a[1] as Images;
			const notice = oversizedImageNotice(images);
			if (notice) throw new Error(notice);
			entry.queuedCommands.commands.push({ text: a[0] as string, images });
			await deps.collab.drainCommands(entry);
		},
		takeQueuedCommand: async (entry, a) => {
			const ref = a[0] as QueuedCommandRef;
			removeQueuedCommand(entry.queuedCommands, ref.index, ref.text);
			void deps.broker.broadcastState(entry).catch(() => {});
		},
		runQueuedCommandNow: async (entry, a) => {
			const ref = a[0] as QueuedCommandRef;
			const command = removeQueuedCommand(entry.queuedCommands, ref.index, ref.text);
			if (!command) return;
			if (!entry.queuedCommands.paused) {
				// Front of the queue: a running turn's agent_end drains it first.
				entry.queuedCommands.commands.unshift(command);
				if (entry.session.isStreaming) await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
				await deps.collab.drainCommands(entry);
				return;
			}
			// Stop paused the queue: run this one now and leave the rest for Resume queue.
			if (entry.session.isStreaming) await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
			await deps.collab.runCommandNow(entry, command);
			void deps.broker.broadcastState(entry).catch(() => {});
		},
		runQueuedNow: async (entry, a) => {
			const ref = a[0] as QueuedMessageRef;
			if (ref.paused === undefined && ref.kind === "follow-up") {
				entry.session.promoteQueuedMessage(ref.text);
				return;
			}
			const message = takeQueuedMessage(entry.session, entry.pausedQueue, ref);
			if (!message) return;
			if (ref.paused !== undefined) {
				if (entry.session.isStreaming) await entry.session.steer(message.text, message.images);
				else void deps.collab.fireAndForgetPrompt(entry, message.text, message.images);
				return;
			}
			await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
			void deps.collab.fireAndForgetPrompt(entry, message.text, message.images);
		},
		// newSession/clearSession/freshSession/deleteSession land via the lifecycle spread below.
		switchSession: (entry, a) => changeSession(entry, "switchSession", a[0] as string),
		branch: (entry, a) => changeSession(entry, "branch", a[0] as string),
		getSessionGraph: async (entry, a) => graph.getSessionGraph(entry, (a[0] ?? {}) as GraphQuery),
		navigateTree: async (entry, a) =>
			graph.navigateTree(entry, a[0] as string, (a[1] ?? {}) as GraphNavigateOptions),
		resumeAfterAskReanswer: async (entry) => graph.resumeAfterAskReanswer(entry),
		retry: (entry) => entry.session.retry(),
		fork: (entry) => entry.session.fork(),
		handoff: (entry, a) => {
			const pending = entry.session.handoff(a[0] as string | undefined);
			// The SDK marks the session compacting before its first await; publish
			// that now so browsers show progress while the document is generated.
			// A throw skips the post-mutation resync, so a failure republishes the
			// cleared flag itself.
			publishState(entry);
			return pending.catch((err: unknown) => {
				publishState(entry);
				throw err;
			});
		},
		setSessionName: (entry, a) => entry.session.setSessionName(a[0] as string, "user"),
		// Phase 9 (SDK 18.2.6): /goal and /plan are NOT ACP-intercepted server-side, so
		// goal/plan control drives the SDK directly. The post-mutation state
		// broadcast re-reads getGoalModeState()/getPlanModeState()?.enabled.
		setPlanModeState: async (entry, a) => {
			const next = a[0] as { enabled: boolean } | undefined;
			if (!next?.enabled) return exitPlanMode(entry);
			// Same path rule as the TUI (#getPlanFilePath): the session's reference path, else the SDK default.
			entry.session.setPlanModeState({
				enabled: true,
				planFilePath: entry.session.getPlanReferencePath() || "local://PLAN.md",
			});
		},
		// Goal runtime owns consent, budgets, and exclusion guards (goal-service).
		goalCreate: (entry, a) => {
			const first = a[0];
			if (typeof first === "object" && first !== null) {
				const input = first as { objective?: unknown; tokenBudget?: number; consent?: boolean };
				return createGoal(entry, {
					objective: String(input.objective ?? ""),
					tokenBudget: input.tokenBudget,
					consent: input.consent,
				});
			}
			return createGoal(entry, { objective: String(first ?? ""), consent: true });
		},
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

		// Model-roles picker (TUI model-hub parity). All three are mutations:
		// none sit in READ_ONLY_METHODS (the post-mutation broadcast refreshes state,
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
				repinModelRole(settings, role);
				// setModel bakes `level` into the persisted role value but keeps the
				// live effort; apply it like the TUI model hub's onAssign does.
				if (level !== undefined) session.setThinkingLevel(level);
				return { role, provider: model.provider, id: model.id };
			}
			const modelRoleValue = formatModelSelectorValue(selector, level);
			if (targetScope === "project") {
				settings.setProjectModelRole(role, modelRoleValue);
			} else {
				settings.setModelRole(role, modelRoleValue);
			}
			repinModelRole(settings, role);
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
			repinModelRole(settings, role);
			if (!wasActive) return { role };
			// The cleared role re-resolves from the newly exposed persisted
			// layer; apply the effective value live when one resolves.
			// applyRoleModel switches without persisting and then applies the
			// role's explicit thinking, which a bare setModel never does live.
			const resolved = resolveRoleModelFull(
				settings,
				role,
				session.getAvailableModels(),
				session.model,
			);
			if (!resolved.model) return { role };
			await session.applyRoleModel({
				role,
				model: resolved.model,
				thinkingLevel: resolved.thinkingLevel,
				explicitThinkingLevel: resolved.explicitThinkingLevel,
			});
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
		setThinkingLevel: async (entry, a) => {
			const { session } = entry;
			const level = a[0] as ConfiguredThinkingLevel;
			const supported = session.getAvailableEffortSelectors();
			if (!supported.includes(level)) {
				const model = session.model
					? `${session.model.provider}/${session.model.id}`
					: "the current model";
				const list = supported.length > 0 ? supported.join(", ") : "none";
				throw new Error(`Thinking "${level}" is not supported by ${model}. Supported: ${list}.`);
			}
			session.setThinkingLevel(level);
		},
		switchModel: async (entry, a) => {
			const { session } = entry;
			const selector = a[0] as string;
			await session.modelRegistry.awaitBackgroundRefresh();
			const scoped = session.scopedModels.map((scopedModel) => scopedModel.model);
			const resolved = resolveCliModel({
				cliModel: selector,
				modelRegistry: session.modelRegistry,
				availableModels: scoped.length > 0 ? scoped : undefined,
				settings: session.settings,
				preferences: getModelMatchPreferences(session.settings),
			});
			if (!resolved.model) throw new Error(resolved.error ?? `Unknown model: ${selector}`);
			await session.setModelTemporary(resolved.model, resolved.thinkingLevel);
			return {
				provider: resolved.model.provider,
				id: resolved.model.id,
				thinkingLevel: resolved.thinkingLevel,
			};
		},
		getModelBrowser: async (entry): Promise<ModelBrowserEntry[]> => {
			const { session } = entry;
			await session.modelRegistry.awaitBackgroundRefresh();
			const usable = new Set(
				// "all": role assignments may name non-chat models (search, tts, ...), which the chat-only default hides.
				session.modelRegistry.getAvailable("all").map((model) => `${model.provider}/${model.id}`),
			);
			const disabled = disabledProviderIds(session.settings);
			return session.modelRegistry.getAll().map((model) => {
				const { provider, id, contextWindow, reasoning } = model;
				const locked: ModelLockReason | undefined = disabled.has(provider)
					? "disabled"
					: usable.has(`${provider}/${id}`)
						? undefined
						: "credentials";
				// Same set the session derives for an active model, minus off/auto.
				const thinkingEfforts = getSupportedEfforts(model);
				return {
					provider,
					id,
					contextWindow,
					reasoning,
					kind: modelKind(model),
					...(thinkingEfforts.length > 0 ? { thinkingEfforts: [...thinkingEfforts] } : {}),
					...(locked ? { locked } : {}),
				};
			});
		},
		setTaskModel: async (entry, a) => {
			const { settings } = entry.session;
			const selector = a[0] as string | null;
			const next = { ...cfgTaskAgentModelOverrides.get(settings) };
			if (selector === null) delete next.task;
			else next.task = selector;
			cfgTaskAgentModelOverrides.override(settings, next);
		},
		getModelPresets: async (entry) => graph.getModelPresets(entry),
		saveModelPreset: async (entry, a) => graph.saveModelPreset(entry, a[0] as string),
		applyModelPreset: async (entry, a) => graph.applyModelPreset(entry, a[0] as string),
		deleteModelPreset: async (entry, a) => graph.deleteModelPreset(entry, a[0] as string),
		getModelMentions: async (entry) => graph.getModelMentions(entry),
		setAutoCompaction: async (entry, a) => {
			entry.session.setAutoCompactionEnabled(a[0] as boolean);
		},
		setAutoRetry: async (entry, a) => {
			entry.session.setAutoRetryEnabled(a[0] as boolean);
			await settingsMethods.publish(entry);
		},
		setFastMode: async (entry, a) => {
			const supported = entry.session.setFastMode(a[0] as boolean);
			await settingsMethods.publish(entry);
			return supported;
		},
		// Read-only rows (READ_ONLY_METHODS): context breakdown and tool schemas (skip the state broadcast).
		getContextBreakdown: async (entry) => entry.session.getContextBreakdown(),
		// `[{ brief: true }]` answers name and a short description only: the stats dialog lists tools
		// and never reads the parameter schemas, which dominate the full answer.
		getToolSchemas: async (entry, a) => {
			const { tools } = entry.session.agent.state;
			if ((a[0] as { brief?: unknown } | undefined)?.brief === true)
				return tools.map((tool): ToolBriefInfo => ({
					name: tool.name,
					description: tool.description.slice(0, TOOL_BRIEF_DESCRIPTION_CHARS),
				}));
			return tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: toolWireSchema(tool),
				examples: tool.examples,
			}));
		},
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
		getSessionStats: async (entry) => entry.session.getSessionStats(),
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
					progress:
						snap.progress === undefined ? undefined : subagentProgressFields(entry, snap.progress),
				};
			});
		},
		getSubagentMessages: async (entry, a) => {
			const selector = a[0] as {
				subagentId?: string;
				sessionFile?: string;
				fromByte?: number;
				maxBytes?: number;
			};
			return readSubagentTranscript(
				await resolveTranscriptFile(entry, selector),
				selector.fromByte,
				selector.maxBytes,
			);
		},
		getSubagentImage: async (entry, a) => {
			const selector = a[0] as { subagentId?: string; hash?: unknown };
			if (typeof selector?.subagentId !== "string") {
				throw new Error("getSubagentImage requires subagentId");
			}
			return readSubagentImage(
				await resolveTranscriptFile(entry, { subagentId: selector.subagentId }),
				selector.hash,
				deps.blobStore ?? new BlobStore(getBlobsDir()),
			);
		},
		subagentSteer: async (entry, a) => {
			await deps.collab.liveSubagentSession(entry, a[0] as string, "steer").steer(a[1] as string);
		},
		subagentAbort: async (entry, a) => {
			await deps.collab.abortSubagent(entry, a[0] as string);
		},
		...createLifecycleMethods({
			sessionsDir: deps.sessionsDir,
			hasCallbackPair: deps.hasCallbackPair,
			mirror: deps.lifecycleMirror,
			assertWritable: async (entry) => {
				if (entry.session.sessionFile == null || !entry.session.sessionFile.endsWith(".jsonl"))
					throw new Error("Session lifecycle refused: no persisted file-backed session");
			},
			settleHostWork: async (entry) => {
				rejectEntryUiRequests(entry, "session lifecycle boundary");
			},
			settleWorkers: async (entry) => {
				for (const id of entry.subagentSnapshots.keys()) {
					await deps.collab.abortSubagent(entry, id).catch(() => {});
				}
			},
			broadcastAvailableCommands: (entry) => deps.broker.broadcastAvailableCommands(entry),
		}),
		...settingsMethods.methods,
		...createAnnotationMethods(),
		...createGitReviewMethods(),
		...createPlanReviewMethods(),
		...createTodoMethods(),
		...createJobMethods(),
		...createComposerMethods(),
		...createMcpMethods({
			broadcastAvailableCommands: (entry) => deps.broker.broadcastAvailableCommands(entry),
		}),
		...createSkillMethods(),
		...createDownloadMethods({
			manifestDeps: (entry) => ({
				sessionId: entry.session.sessionId,
				...(entry.session.sessionFile ? { sessionFile: entry.session.sessionFile } : {}),
				sessionsDir: deps.sessionsDir,
				artifactsDir: entry.session.sessionManager.getArtifactsDir() ?? undefined,
			}),
			roots: () => [deps.sessionsDir, os.tmpdir()],
		}),
		...Object.fromEntries(
			Object.entries(
				createResumeHandlers({
					cwd: deps.cwd,
					sessionsRoot: deps.sessionsDir,
					lifecycleMirror: deps.lifecycleMirror,
				}),
			).map(([name, handler]) => [
				name,
				(entry: SessionEntry, args: unknown[]) => handler(args, entry),
			]),
		),
		compactionSnapshot: async (entry) => compactionSnapshot(entry.session),
		compactEx: async (entry, a) => {
			const input = (a[0] ?? {}) as { mode?: unknown; instructions?: unknown };
			// No mode runs the configured compaction.methodOrder (bare /compact), never a fixed soft pass.
			return executeCompaction(entry.session, {
				...(typeof input.mode === "string" && input.mode ? { mode: input.mode } : {}),
				...(typeof input.instructions === "string" ? { instructions: input.instructions } : {}),
				// The post-mutation state broadcast clears the flag; this one raises it.
				onStarted: () => publishState(entry),
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
		advisorGetStatus: async (entry, a) => {
			const section = (a[0] as { section?: string } | undefined)?.section;
			if (section === "stats") return getAdvisorStats(entry);
			if (section === "warnings") return getAdvisorWarnings(entry);
			return getAdvisorOverview(entry);
		},
		advisorConfigure: async (entry, a) => {
			const enabled = (a[0] as { enabled?: unknown } | undefined)?.enabled;
			if (typeof enabled !== "boolean")
				throw new Error("advisorConfigure requires { enabled: boolean }");
			return setAdvisorEnabled(entry, enabled);
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
		listPlugins: async (_entry, a) => plugins.listPlugins(a),
		getPluginConfig: async (_entry, a) => plugins.getPluginConfig(a),
		setPluginEnabled: async (_entry, a) => plugins.setPluginEnabled(a),
		setPluginFeatures: async (_entry, a) => plugins.setPluginFeatures(a),
		setPluginSetting: async (_entry, a) => plugins.setPluginSetting(a),
	};

	return {
		methods: METHODS,
		readOnly: READ_ONLY_METHODS,
		nameOnly: NAME_ONLY,
		notReadyGated: NOT_READY_GATED,
		historyReload: HISTORY_RELOAD,
		getInFlightBash: () => inFlightBash,
		getInFlightPython: () => inFlightPython,
	};
}
