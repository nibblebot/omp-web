import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createAgentSession, type ModelRegistry, type Settings } from "@oh-my-pi/pi-coding-agent";
import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	type CollabPromptDetails,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { CollabWireStatus } from "../shared/protocol";
import type { CollabAgentRef, CollabHostStatus, CollabSessionPort } from "./collab-host";
import type { SessionConfig } from "./config";
import type { DaemonBroker } from "./daemon-broker";
import { BOOT_HANDLE, type SessionEntry } from "./session-entry";
import { broadcast, broadcastTo, notifyEvent } from "./sse-delivery";
import { handleSubagentLifecycle, handleSubagentProgress } from "./subagent-mirror";
import { buildUiContext } from "./ui-context";

// ---------------------------------------------------------------------------
// Collab session port (Slice C): the daemon's per-session surface the collab
// host adapter drives — session getters, event/entry/bus taps, guest prompt
// injection, agent roster/control, and transcript resolution. Also owns the
// slash runtime and the session factory itself (createSession).
// ---------------------------------------------------------------------------

export type Images = ImageContent[] | undefined;

export interface CollabSessionDeps {
	config: SessionConfig;
	agentDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	broker: DaemonBroker;
}

export interface CollabSession {
	createSession(sessionCwd: string): Promise<SessionEntry>;
	buildCollabPort(entry: SessionEntry): CollabSessionPort;
	toWireStatus(status: CollabHostStatus | null): CollabWireStatus;
	liveSubagentSession(entry: SessionEntry, agentId: string, op: "steer" | "abort"): AgentSession;
	abortSubagent(entry: SessionEntry, agentId: string): Promise<void>;
	fireAndForgetPrompt(entry: SessionEntry, text: string, images: Images): void;
	runBuiltinSlashCommand(entry: SessionEntry, text: string, images: Images): Promise<boolean>;
}

export function createCollabSession(deps: CollabSessionDeps): CollabSession {
	/** Collab wire rosters only carry running/idle/parked/aborted; the mirror's wider status union maps down. */
	function collabAgentStatus(status: AgentProgress["status"]): CollabAgentRef["status"] {
		if (status === "running" || status === "pending") return "running";
		if (status === "aborted") return "aborted";
		return "idle";
	}

	function buildCollabPort(entry: SessionEntry): CollabSessionPort {
		const { session } = entry;
		return {
			getSessionId: () => session.sessionId,
			getCwd: () => session.sessionManager.getCwd(),
			getSessionName: () => session.sessionName,
			isStreaming: () => session.isStreaming,
			isAborting: () => session.isAborting,
			queuedMessageCount: () => session.queuedMessageCount,
			getModel: () => session.model,
			getThinkingLevel: () => session.thinkingLevel,
			getContextUsage: () => session.getContextUsage(),
			snapshot: () => session.sessionManager.snapshotForReplication(),
			subscribe: (cb) => session.subscribe(cb),
			// Single slot; the adapter restores it (with null) on teardown.
			onEntryAppended: (cb) => {
				session.sessionManager.onEntryAppended = cb ?? undefined;
			},
			// Both task channels: the same EventBus traffic the subagent mirror taps.
			subscribeBus: (cb) => {
				const unsubs = [
					entry.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data) =>
						cb(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data),
					),
					entry.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data) =>
						cb(TASK_SUBAGENT_PROGRESS_CHANNEL, data),
					),
				];
				return () => {
					for (const unsub of unsubs) unsub();
				};
			},
			subscribeAgents: (cb) => {
				const unsubRegistry = entry.agentRegistry.onChange(() => cb());
				entry.onSubagentsChange = cb;
				return () => {
					unsubRegistry();
					entry.onSubagentsChange = null;
				};
			},
			emitNotice: (level, message) => notifyEvent(entry, message, level),
			promptFromGuest: (text, images, fromName) =>
				session.promptCustomMessage(
					{
						customType: COLLAB_PROMPT_MESSAGE_TYPE,
						content: images?.length ? [{ type: "text", text }, ...images] : text,
						display: true,
						details: { from: fromName } satisfies CollabPromptDetails,
						attribution: "user",
					},
					{ streamingBehavior: "steer", queueChipText: text },
				),
			abort: () => session.abort({ reason: USER_INTERRUPT_LABEL }),
			listAgents: () => {
				const refs: CollabAgentRef[] = [];
				// Main lives in the per-session registry; task subagents register in
				// AgentRegistry.global() and are mirrored per-session as snapshots.
				for (const ref of entry.agentRegistry.list()) {
					if (ref.kind !== "main") continue;
					refs.push({
						id: ref.id,
						kind: "main",
						displayName: ref.displayName,
						status: ref.status,
						hasSessionFile: !!ref.sessionFile,
						createdAt: ref.createdAt,
						lastActivity: ref.lastActivity,
					});
				}
				for (const snap of entry.subagentSnapshots.values()) {
					const ref = AgentRegistry.global().get(snap.id);
					refs.push({
						id: snap.id,
						kind: "sub",
						displayName: ref?.displayName ?? snap.agent ?? snap.id,
						status: ref?.status ?? collabAgentStatus(snap.status),
						parentId: snap.parentToolCallId,
						hasSessionFile: !!snap.sessionFile,
						createdAt: ref?.createdAt ?? 0,
						lastActivity: ref?.lastActivity ?? snap.lastUpdate,
					});
				}
				return refs;
			},
			agentCmd: async (cmd, agentId, text) => {
				if (cmd === "chat") {
					if (agentId === MAIN_AGENT_ID) {
						// Fire-and-forget: prompt resolves at turn end; failures are
						// logged (the adapter targets its own error frames).
						void session.prompt(text ?? "", { streamingBehavior: "steer" }).catch((err) => {
							console.error("collab guest prompt failed:", err);
						});
					} else {
						await liveSubagentSession(entry, agentId, "steer").steer(text ?? "");
					}
					return;
				}
				if (cmd === "kill") {
					if (agentId === MAIN_AGENT_ID) await session.abort({ reason: USER_INTERRUPT_LABEL });
					else await abortSubagent(entry, agentId);
					return;
				}
				// revive: the Main agent cannot be revived (it never dies).
				if (agentId === MAIN_AGENT_ID) throw new Error("no such agent");
				await AgentLifecycleManager.global().ensureLive(agentId);
			},
			resolveTranscriptFile: (agentId) =>
				agentId === MAIN_AGENT_ID
					? (session.sessionFile ?? null)
					: (entry.transcriptSessionFilesBySubagentId.get(agentId) ??
						entry.subagentSnapshots.get(agentId)?.sessionFile ??
						null),
		};
	}

	/** Map the adapter's host status onto the wire status web clients render. */
	function toWireStatus(status: CollabHostStatus | null): CollabWireStatus {
		if (!status) return { state: "off" };
		if (status.state === "error") return { state: "error", error: status.error ?? "collab error" };
		return {
			state: "live",
			link: status.link,
			viewLink: status.viewLink,
			relayUrl: status.relayUrl,
			roomId: status.roomId,
			participants: status.participants,
			maxGuests: deps.config.collabMaxGuests,
		};
	}

	// Slash commands typed into chat run through the ACP builtin dispatch before
	// hitting the model (parity with RPC mode's prompt flow).
	function buildSlashRuntime(entry: SessionEntry): SlashCommandRuntime {
		const { session } = entry;
		return {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: (text) => notifyEvent(entry, text),
			refreshCommands: () => deps.broker.broadcastAvailableCommands(entry),
			// No plugin-state reloader is wired in the web host; re-advertising the
			// command list is the observable part of the reload.
			reloadPlugins: () => deps.broker.broadcastAvailableCommands(entry),
			notifyTitleChanged: () => deps.broker.broadcastState(entry),
			notifyConfigChanged: () => deps.broker.broadcastState(entry),
		};
	}

	function wireSession(entry: SessionEntry): void {
		const { session, eventBus } = entry;
		// session.subscribe covers the entire AgentSessionEvent union — the same
		// frames the RPC child emitted onSessionEvent.
		session.subscribe((event) => {
			broadcastTo(entry.handle, { type: "event", event });
			// Tokens/cost/context/queue counts all change at turn end.
			if (event.type === "agent_end") void deps.broker.broadcastState(entry, true).catch(() => {});
		});
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, (data) => {
			handleSubagentLifecycle(entry, data as SubagentLifecyclePayload);
		});
		eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, (data) => {
			handleSubagentProgress(entry, data as SubagentProgressPayload);
		});
	}

	async function createSession(sessionCwd: string): Promise<SessionEntry> {
		const agentRegistry = new AgentRegistry();
		const eventBus = new EventBus();
		const result = await createAgentSession({
			cwd: sessionCwd,
			agentDir: deps.agentDir,
			authStorage: deps.authStorage,
			modelRegistry: deps.modelRegistry,
			settings: deps.settings,
			sessionManager: SessionManager.create(sessionCwd),
			agentRegistry,
			eventBus,
			hasUI: true,
		});
		const entry: SessionEntry = {
			handle: BOOT_HANDLE,
			cwd: sessionCwd,
			session: result.session,
			agentRegistry,
			eventBus,
			// Assigned right below: the runtime's closures need the entry.
			slashRuntime: undefined!,
			pendingUiRequests: new Map(),
			subagentSnapshots: new Map(),
			transcriptSessionFilesBySubagentId: new Map(),
			staleSubagentIds: new Set(),
			collab: { adapter: null, starting: false },
			onSubagentsChange: null,
		};
		entry.slashRuntime = buildSlashRuntime(entry);
		// Feeds the tool UI context; without hasUI the ask tool never registers.
		result.setToolUIContext(buildUiContext(entry), true);
		wireSession(entry);
		return entry;
	}

	// Fire-and-forget: prompt resolves at turn end, so awaiting it would block
	// the relay. Failures surface as an error frame.
	function fireAndForgetPrompt(entry: SessionEntry, text: string, images: Images): void {
		entry.session
			.prompt(text, { images })
			.catch((err) => broadcast({ type: "error", error: String(err) }));
		maybeGenerateTitle(entry, text);
	}

	// Auto-name unnamed sessions from the first prompt, mirroring the TUI's
	// input-controller title flow: skip when already named or PI_NO_TITLE is set,
	// re-check the name before writing so a concurrent namer wins. The SDK's
	// generateSessionTitle already rejects low-signal inputs.
	function maybeGenerateTitle(entry: SessionEntry, text: string): void {
		const { sessionManager } = entry.session;
		if (sessionManager.getSessionName() || Bun.env.PI_NO_TITLE) return;
		entry.session
			.generateTitle(text)
			.then(async (title) => {
				if (title && !sessionManager.getSessionName()) {
					await sessionManager.setSessionName(title, "auto");
				}
			})
			.catch(() => {});
	}

	/** Runs builtin / commands (/export, /compact, …); returns true when the input was consumed. */
	async function runBuiltinSlashCommand(
		entry: SessionEntry,
		text: string,
		images: Images,
	): Promise<boolean> {
		const builtinResult = await executeAcpBuiltinSlashCommand(text, entry.slashRuntime);
		if (builtinResult === false) return false;
		if ("prompt" in builtinResult) fireAndForgetPrompt(entry, builtinResult.prompt, images);
		return true;
	}

	/**
	 * Steer target: a registered agent with a live, running session. Parked refs have session null.
	 * Task subagents register in AgentRegistry.global() (executor.ts hardcodes it), NOT the session's
	 * private registry — that one only ever holds "Main". The per-session allowlist is the lifecycle
	 * mirror: an id absent from subagentSnapshots belongs to another session (or no session) and is rejected.
	 */
	function liveSubagentSession(
		entry: SessionEntry,
		agentId: string,
		op: "steer" | "abort",
	): AgentSession {
		if (!entry.subagentSnapshots.has(agentId))
			throw new Error(`Cannot ${op} agent ${agentId}: no such agent`);
		const ref = AgentRegistry.global().get(agentId);
		if (!ref) throw new Error(`Cannot ${op} agent ${agentId}: no such agent`);
		if (ref.status !== "running" || !ref.session) {
			throw new Error(`Cannot ${op} agent ${agentId}: not running (status: ${ref.status})`);
		}
		return ref.session;
	}

	/**
	 * Abort mirrors the hub tool's cancel path (tools/hub/jobs.ts executeCancel): kill the async job
	 * first — bare session.abort() only interrupts the in-flight turn and the executor keeps the job
	 * running. Jobless registrations (pre-job spawn, idle/parked zombies) die via abort + lifecycle release.
	 */
	async function abortSubagent(entry: SessionEntry, agentId: string): Promise<void> {
		if (!entry.subagentSnapshots.has(agentId))
			throw new Error(`Cannot abort agent ${agentId}: no such agent`);
		const manager = entry.session.asyncJobManager;
		const job = manager?.getJob(agentId);
		if (job) {
			if (job.status === "running") {
				if (!manager!.cancel(agentId))
					throw new Error(`Cannot abort agent ${agentId}: job already settled`);
				return;
			}
			// Settled job row: fall through to the registration kill (rows outlive
			// the run inside the retention window while the agent lives on).
		}
		const ref = AgentRegistry.global().get(agentId);
		if (!ref) throw new Error(`Cannot abort agent ${agentId}: no such agent`);
		if (ref.status === "running" && ref.session) {
			await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
		}
		await AgentLifecycleManager.global().release(agentId);
	}

	return {
		createSession,
		buildCollabPort,
		toWireStatus,
		liveSubagentSession,
		abortSubagent,
		fireAndForgetPrompt,
		runBuiltinSlashCommand,
	};
}
