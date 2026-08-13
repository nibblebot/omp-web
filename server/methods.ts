import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { Settings } from "@oh-my-pi/pi-coding-agent";
import { SETTINGS_SCHEMA, type SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { getAvailableThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { InspectImageMode } from "@oh-my-pi/pi-coding-agent/utils/inspect-image-mode";
import type { WebMethodName } from "../shared/protocol";
import type { CollabSession, Images } from "./collab-session";
import type { DaemonBroker } from "./daemon-broker";
import type { SessionEntry } from "./session-entry";
import { applySettingSideEffects, buildSettingsModel, coerceSettingValue } from "./settings-model";
import { broadcastTo, clearEphemeralAbort, ephemeralAborts, setEphemeralAbort } from "./sse-delivery";
import { clearSubagents, readSubagentTranscript, resolveSubagentSessionFile } from "./subagent-mirror";

// ---------------------------------------------------------------------------
// The METHODS dispatch table: every WebMethodName the POST /command `call`
// route can invoke. Rows are closures over the session entry; the boot-local
// settings/authStorage singletons and the collab-session / daemon-broker
// surfaces are injected at construction. The dispatch core itself (routing,
// readiness gate, resync, login special-casing) lives in server/index.ts.
// ---------------------------------------------------------------------------

export interface WebMethodsDeps {
	settings: Settings;
	authStorage: AuthStorage;
	collab: CollabSession;
	broker: DaemonBroker;
}

export interface WebMethods {
	methods: Record<WebMethodName, (entry: SessionEntry, args: unknown[], streamId?: number) => Promise<unknown>>;
	readOnly: Partial<Record<WebMethodName, true>>;
	notReadyGated: Partial<Record<WebMethodName, true>>;
	historyReload: Partial<Record<WebMethodName, true>>;
	getInFlightBash(): number;
	getInFlightPython(): number;
}

export function createWebMethods(deps: WebMethodsDeps): WebMethods {
	/** In-flight user bash/python calls (idle suppression, R11) — wrapper counters around METHODS rows. */
	let inFlightBash = 0;
	let inFlightPython = 0;

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
	// handoff starts a new session server-side; fork rewrites history in place.
	const HISTORY_RELOAD: Partial<Record<WebMethodName, true>> = { newSession: true, switchSession: true, branch: true, fork: true, handoff: true };

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
			const ok = await session.switchSession(arg as string);
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

	const METHODS: Record<WebMethodName, (entry: SessionEntry, args: unknown[], streamId?: number) => Promise<unknown>> = {
		prompt: async (entry, a) => {
			const text = a[0] as string;
			const images = a[1] as Images;
			if (await deps.collab.runBuiltinSlashCommand(entry, text, images)) return undefined;
			deps.collab.fireAndForgetPrompt(entry, text, images);
			return undefined;
		},
		steer: (entry, a) => entry.session.steer(a[0] as string, a[1] as Images),
		followUp: (entry, a) => entry.session.followUp(a[0] as string, a[1] as Images),
		getQueuedMessages: async entry => entry.session.getQueuedMessages(),
		popLastQueuedMessage: async entry => entry.session.popLastQueuedMessage(),
		clearQueue: async entry => entry.session.clearQueue(),
		abort: entry => entry.session.abort({ reason: USER_INTERRUPT_LABEL }),
		abortAndPrompt: async (entry, a) => {
			await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
			deps.collab.fireAndForgetPrompt(entry, a[0] as string, a[1] as Images);
		},
		newSession: (entry, a) => changeSession(entry, "newSession", a[0] as string | undefined),
		switchSession: (entry, a) => changeSession(entry, "switchSession", a[0] as string),
		branch: (entry, a) => changeSession(entry, "branch", a[0] as string),
		compact: (entry, a) => entry.session.compact(a[0] as string | undefined),
		retry: entry => entry.session.retry(),
		fork: entry => entry.session.fork(),
		// Sync SDK method: resets provider streams, keeps the transcript — the
		// post-mutation state broadcast picks up the new sessionId.
		freshSession: async entry => entry.session.freshSession() ?? null,
		handoff: (entry, a) => entry.session.handoff(a[0] as string | undefined),
		setSessionName: (entry, a) => entry.session.setSessionName(a[0] as string, "user"),
		setInterruptMode: async (entry, a) => {
			entry.session.setInterruptMode(a[0] as "immediate" | "wait");
		},
		// Phase 9 (17.1.8): /goal and /plan are NOT ACP-intercepted server-side, so
		// goal/plan control drives the SDK directly. The post-mutation state
		// broadcast re-reads getGoalModeState()/getPlanModeState()?.enabled.
		setGoalModeState: async (entry, a) => {
			entry.session.setGoalModeState(a[0] as GoalModeState | undefined);
		},
		setPlanModeState: async (entry, a) => {
			entry.session.setPlanModeState(a[0] as PlanModeState | undefined);
		},
		// goalRuntime rows: createGoal throws when a goal is already active
		// (matching the CLI's refusal) — the client only offers "set" with no goal.
		goalCreate: (entry, a) => entry.session.goalRuntime.createGoal({ objective: String(a[0] ?? "") }),
		goalPause: entry => entry.session.goalRuntime.pauseGoal(),
		goalResume: entry => entry.session.goalRuntime.resumeGoal(),
		goalDrop: entry => entry.session.goalRuntime.dropGoal(),
		formatSessionAsText: async entry => entry.session.formatSessionAsText(),
		// Dump lands in os.tmpdir(), already inside the /download realpath jail.
		dumpLlmRequestToTmpDir: entry => entry.session.dumpLlmRequestToTmpDir(),
		setModel: async (entry, a) => {
			const { session } = entry;
			const [provider, modelId] = [a[0] as string, a[1] as string];
			let model = session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
			if (!model) {
				// Cold start: discovery-backed providers populate seconds after
				// session ready; wait for in-flight discovery before giving up.
				await session.modelRegistry.awaitBackgroundRefresh();
				model = session.getAvailableModels().find(m => m.provider === provider && m.id === modelId);
			}
			if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
			await session.setModel(model);
			return model;
		},
		cycleModel: async entry => (await entry.session.cycleModel()) ?? null,
		getAvailableModels: async entry => {
			await entry.session.modelRegistry.awaitBackgroundRefresh();
			return entry.session.getAvailableModels();
		},
		// Settings panel (TUI /settings parity). getSettings is READ_ONLY; the
		// model is built fresh per call from the shared Settings singleton.
		getSettings: async entry => {
			await entry.session.modelRegistry.awaitBackgroundRefresh();
			return buildSettingsModel(entry.session, await getAvailableThemes());
		},
		setSetting: async (entry, a) => {
			const [path, value] = [String(a[0]), a[1]];
			const coerced = coerceSettingValue(path, value);
			// All accepted paths are schema paths persisted via the shared
			// Settings singleton (in-process merge + debounced disk write — the
			// TUI's settings.set semantics).
			if (path in SETTINGS_SCHEMA) {
				deps.settings.set(path as SettingPath, coerced as never);
			}
			await applySettingSideEffects(entry.session, path, coerced);
			const model = buildSettingsModel(entry.session, await getAvailableThemes());
			broadcastTo(entry.handle, { type: "settings_changed", model });
			return model;
		},
		setThinkingLevel: async (entry, a) => {
			entry.session.setThinkingLevel(a[0] as ThinkingLevel);
		},
		cycleThinkingLevel: async entry => {
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
		abortRetry: async entry => {
			entry.session.abortRetry();
		},
		setFastMode: async (entry, a) => {
			entry.session.setFastMode(a[0] as boolean);
		},
		setComputerToolEnabled: (entry, a) => entry.session.setComputerToolEnabled(a[0] as boolean),
		setInspectImageMode: (entry, a) => entry.session.setInspectImageMode(a[0] as InspectImageMode),
		// READ_ONLY rows: usage reports + context breakdown (skip the state broadcast).
		fetchUsageReports: entry => entry.session.fetchUsageReports(),
		getContextBreakdown: async entry => entry.session.getContextBreakdown(),
		// Phase 10: onChunk relays live output as session-scoped chunk frames
		// (streamId = the client's bash-item id). `!!`/`$$` dimmed variants are
		// excluded from the agent's context, matching the TUI semantic.
		// In-flight counters feed the idle auto-exit check (R11).
		bash: (entry, a, streamId) => {
			inFlightBash++;
			return entry.session
				.executeBash(a[0] as string, chunk => {
					if (streamId !== undefined) broadcastTo(entry.handle, { type: "bash_chunk", id: streamId, text: chunk });
				}, { excludeFromContext: a[1] === true })
				.finally(() => {
					inFlightBash--;
				});
		},
		abortBash: async entry => {
			entry.session.abortBash();
		},
		python: (entry, a, streamId) => {
			inFlightPython++;
			return entry.session
				.executePython(a[0] as string, chunk => {
					if (streamId !== undefined) broadcastTo(entry.handle, { type: "python_chunk", id: streamId, text: chunk });
				}, { excludeFromContext: a[1] === true })
				.finally(() => {
					inFlightPython--;
				});
		},
		abortEval: async entry => {
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
					onTextDelta: chunk => {
						if (streamId !== undefined) broadcastTo(entry.handle, { type: "ephemeral_delta", id: streamId, text: chunk });
					},
				})
				.then(
					result => {
						if (streamId !== undefined) clearEphemeralAbort(entry, streamId);
						return { replyText: result.replyText };
					},
					err => {
						if (streamId !== undefined) clearEphemeralAbort(entry, streamId);
						throw err;
					},
				);
		},
		abortEphemeral: async (entry, _a, streamId) => {
			if (streamId === undefined) return;
			ephemeralAborts.get(entry)?.get(streamId)?.abort();
		},
		getSessionStats: async entry => entry.session.getSessionStats(),
		exportHtml: async (entry, a) => ({ path: await entry.session.exportToHtml(a[0] ? String(a[0]) : undefined, a[1] === true) }),
		getBranchMessages: async entry => entry.session.getUserMessagesForBranching(),
		getLoginProviders: async () =>
			getOAuthProviders().map(provider => ({
				id: provider.id,
				name: provider.name,
				available: provider.available,
				authenticated: deps.authStorage.hasAuth(provider.id),
			})),
		login: () => Promise.reject(new Error("login is handled per-socket")),
		getSubagents: async entry => {
			// Roster from the per-session lifecycle mirror (task subagents register in
			// AgentRegistry.global(), not the private registry), enriched with live
			// registry data when the global ref still exists.
			return [...entry.subagentSnapshots.values()].map(snap => {
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
			const selector = a[0] as { subagentId?: string; sessionFile?: string; fromByte?: number };
			return readSubagentTranscript(resolveSubagentSessionFile(entry, selector), selector.fromByte);
		},
		subagentSteer: async (entry, a) => {
			await deps.collab.liveSubagentSession(entry, a[0] as string, "steer").steer(a[1] as string);
		},
		subagentAbort: async (entry, a) => {
			await deps.collab.abortSubagent(entry, a[0] as string);
		},
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
