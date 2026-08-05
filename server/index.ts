import { readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { isZodSchema, zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import {
	createAgentSession,
	discoverAuthStorage,
	ModelRegistry,
	Settings,
	type ExtensionAskDialogResult,
	type ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { FileEntry, SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { listAllSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getAgentDir, isEnoent } from "@oh-my-pi/pi-utils";
import type { ServerWebSocket } from "bun";
import type {
	ClientCommand,
	WebMethodName,
	WebSessionState,
	SubagentMessagesResult,
	ServerFrame,
	SessionListEntry,
	SessionScopedFrame,
	LiveSessionEntry,
	ProcessStats,
} from "../src/protocol";

// ---------------------------------------------------------------------------
// Bootstrap: one shared authStorage/modelRegistry pair (the SDK enforces the
// pairing), one Settings instance, then the in-process session registry.
// Phase 2: N concurrent sessions live in `sessions`, keyed by a stable
// server-assigned handle (s1, s2, … — NOT the agent sessionId, which changes
// on switchSession). Each socket attaches to exactly one handle; that
// attachment routes call/login_code/ui_response and all session-scoped frames.
// ---------------------------------------------------------------------------

const cwd = process.env.OMP_WEB_CWD ?? process.cwd();
// TUI default global config directory (~/.omp/agent; sdk.ts documents the same).
const agentDir = getAgentDir();
const authStorage = await discoverAuthStorage(agentDir);
const modelRegistry = new ModelRegistry(authStorage);
const settings = await Settings.init({ cwd, agentDir });

interface SocketData {
	/** Handle of the session this socket is attached to (null = detached). */
	attached: string | null;
}
type Ws = ServerWebSocket<SocketData>;

const sockets = new Set<Ws>();

/** Global frames only (error). Session-scoped frames MUST go through broadcastTo/sendScoped. */
function broadcast(frame: ServerFrame): void {
	const data = JSON.stringify(frame);
	for (const ws of sockets) ws.send(data);
}

function send(ws: Ws, frame: ServerFrame): void {
	ws.send(JSON.stringify(frame));
}

/** Stamp the session handle and deliver a session-scoped frame to one socket. */
function sendScoped(ws: Ws, handle: string, frame: SessionScopedFrame): void {
	send(ws, { ...frame, sessionId: handle });
}

/** Stamp the session handle and deliver a session-scoped frame to every socket attached to it. */
function broadcastTo(handle: string, frame: SessionScopedFrame): void {
	const data = JSON.stringify({ ...frame, sessionId: handle });
	for (const ws of sockets) if (ws.data.attached === handle) ws.send(data);
}

/** Surface operator-facing text as the existing notice event frame. */
function notifyEvent(entry: SessionEntry, message: string, level: "info" | "warning" | "error" = "info"): void {
	broadcastTo(entry.handle, { type: "event", event: { type: "notice", level, message } });
}

// ---------------------------------------------------------------------------
// ExtensionUIContext (plan §1.7): the dialog subset round-trips over the
// socket as ui_request/ui_response frames; terminal-only surface is stubbed.
// Pending requests live on the owning SessionEntry, target only that
// session's attached sockets, and are rejected when every targeted socket has
// closed and on session close / server shutdown.
// ---------------------------------------------------------------------------

let nextUiRequestId = 1;

function uiRequest(entry: SessionEntry, method: string, params: unknown): Promise<unknown> {
	const targets = new Set<Ws>();
	for (const ws of sockets) if (ws.data.attached === entry.handle) targets.add(ws);
	if (targets.size === 0) return Promise.reject(new Error("No connected client to answer the UI request"));
	const id = `ui${nextUiRequestId++}`;
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	entry.pendingUiRequests.set(id, { sockets: targets, resolve, reject });
	broadcastTo(entry.handle, { type: "ui_request", id, method, params });
	return promise;
}

function rejectEntryUiRequests(entry: SessionEntry, reason: string): void {
	for (const [id, p] of entry.pendingUiRequests) {
		p.reject(new Error(reason));
		entry.pendingUiRequests.delete(id);
	}
}

/** One context per session: dialog requests and notices route to that session's sockets. */
function buildUiContext(entry: SessionEntry): ExtensionUIContext {
	return {
		select: (title, options) => uiRequest(entry, "select", { title, options }) as Promise<string | undefined>,
		confirm: async (title, message) => Boolean(await uiRequest(entry, "confirm", { title, message })),
		input: (title, placeholder) => uiRequest(entry, "input", { title, placeholder }) as Promise<string | undefined>,
		editor: (title, prefill) => uiRequest(entry, "editor", { title, prefill }) as Promise<string | undefined>,
		askDialog: questions => uiRequest(entry, "askDialog", { questions }) as Promise<ExtensionAskDialogResult | undefined>,
		notify: (message, type) => notifyEvent(entry, message, type ?? "info"),
		// --- Terminal-only surface: no-ops in the headless web host. ---
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: () => Promise.reject(new Error("Custom UI components are not supported in the web host")),
		setEditorText: () => {},
		pasteToEditor: () => {},
		getEditorText: () => "",
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		theme: {} as ExtensionUIContext["theme"],
		getAllThemes: () => Promise.resolve([]),
		getTheme: () => Promise.resolve(undefined),
		setTheme: () => Promise.resolve({ success: false, error: "Themes are not supported in the web host" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

// ---------------------------------------------------------------------------
// Subagent mirror: a port of the RPC mode's subagent registry semantics at a
// fixed "progress" subscription level (subagent_event frames were never
// emitted at that level, so the raw event channel is not relayed). Lifecycle
// and progress payloads are broadcast verbatim — the client parses exactly
// these shapes. The mirror state lives on the owning SessionEntry (rosters
// stay namespaced per session) and owns subagentId → sessionFile resolution
// for transcript reads, including finished agents.
// ---------------------------------------------------------------------------

interface SubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	parentToolCallId?: string;
	lastUpdate: number;
	progress?: AgentProgress;
}

const MAX_RETAINED_TRANSCRIPT_REFERENCES = 256;

function isSessionMessageEntry(entry: FileEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function statusFromLifecycle(status: SubagentLifecyclePayload["status"]): AgentProgress["status"] {
	return status === "started" ? "running" : status;
}

function hasSameOwner(
	payload: Pick<SubagentLifecyclePayload | SubagentProgressPayload, "parentToolCallId" | "sessionFile">,
	snapshot: SubagentSnapshot,
): boolean {
	if (payload.parentToolCallId !== undefined && snapshot.parentToolCallId !== undefined) {
		return payload.parentToolCallId === snapshot.parentToolCallId;
	}
	if (payload.sessionFile !== undefined && snapshot.sessionFile !== undefined) {
		return payload.sessionFile === snapshot.sessionFile;
	}
	return true;
}

function addPruned(set: Set<string>, value: string, maxSize: number): void {
	set.delete(value);
	set.add(value);
	while (set.size > maxSize) {
		const oldest = set.keys().next();
		if (oldest.done) break;
		set.delete(oldest.value);
	}
}

function rememberTranscriptSession(entry: SessionEntry, subagentId: string, sessionFile: string | undefined): void {
	if (!sessionFile) return;
	entry.transcriptSessionFilesBySubagentId.delete(subagentId);
	entry.transcriptSessionFilesBySubagentId.set(subagentId, sessionFile);
	while (entry.transcriptSessionFilesBySubagentId.size > MAX_RETAINED_TRANSCRIPT_REFERENCES) {
		const oldest = entry.transcriptSessionFilesBySubagentId.keys().next();
		if (oldest.done) break;
		entry.transcriptSessionFilesBySubagentId.delete(oldest.value);
	}
}

function hasTranscriptSessionFile(entry: SessionEntry, sessionFile: string): boolean {
	for (const snapshot of entry.subagentSnapshots.values()) {
		if (snapshot.sessionFile === sessionFile) return true;
	}
	for (const transcriptSessionFile of entry.transcriptSessionFilesBySubagentId.values()) {
		if (transcriptSessionFile === sessionFile) return true;
	}
	return false;
}

/** Session change drops every tracked subagent; late frames from the old session are stale. */
function clearSubagents(entry: SessionEntry): void {
	for (const subagentId of entry.subagentSnapshots.keys()) {
		addPruned(entry.staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
	}
	for (const subagentId of entry.transcriptSessionFilesBySubagentId.keys()) {
		addPruned(entry.staleSubagentIds, subagentId, MAX_RETAINED_TRANSCRIPT_REFERENCES);
	}
	entry.subagentSnapshots.clear();
	entry.transcriptSessionFilesBySubagentId.clear();
}

// Payloads are JSON-safe snapshots; drop a frame rather than kill the relay
// if one ever isn't serializable.
function broadcastSubagentFrame(entry: SessionEntry, type: "subagent_lifecycle" | "subagent_progress", payload: unknown): void {
	try {
		broadcastTo(entry.handle, { type, payload });
	} catch (err) {
		console.error(`Dropping unserializable ${type} frame:`, err);
	}
}

function handleSubagentLifecycle(entry: SessionEntry, payload: SubagentLifecyclePayload): void {
	const existing = entry.subagentSnapshots.get(payload.id);
	if (existing && !hasSameOwner(payload, existing)) return;
	if (!existing && payload.status !== "started") return;
	if (payload.status === "started") {
		entry.staleSubagentIds.delete(payload.id);
	}
	const sessionFile = payload.sessionFile ?? existing?.sessionFile;
	const snapshot: SubagentSnapshot = {
		id: payload.id,
		index: payload.index,
		agent: payload.agent,
		description: payload.description ?? existing?.description,
		status: statusFromLifecycle(payload.status),
		task: existing?.task,
		assignment: existing?.assignment,
		sessionFile,
		parentToolCallId: payload.parentToolCallId ?? existing?.parentToolCallId,
		lastUpdate: Date.now(),
		progress: existing?.progress,
	};
	rememberTranscriptSession(entry, payload.id, sessionFile);
	if (payload.status === "started") {
		entry.subagentSnapshots.set(payload.id, snapshot);
	} else {
		entry.subagentSnapshots.delete(payload.id);
	}
	broadcastSubagentFrame(entry, "subagent_lifecycle", payload);
}

function handleSubagentProgress(entry: SessionEntry, payload: SubagentProgressPayload): void {
	const progress = payload.progress;
	if (entry.staleSubagentIds.has(progress.id)) return;
	const existing = entry.subagentSnapshots.get(progress.id);
	if (!existing) return;
	if (!hasSameOwner(payload, existing)) return;
	const sessionFile = payload.sessionFile ?? existing.sessionFile;
	rememberTranscriptSession(entry, progress.id, sessionFile);
	entry.subagentSnapshots.set(progress.id, {
		id: progress.id,
		index: payload.index,
		agent: payload.agent,
		description: progress.description ?? existing.description,
		status: progress.status,
		task: payload.task,
		assignment: payload.assignment,
		sessionFile,
		lastUpdate: Date.now(),
		parentToolCallId: payload.parentToolCallId ?? existing.parentToolCallId,
		progress,
	});
	broadcastSubagentFrame(entry, "subagent_progress", payload);
}

function resolveSubagentSessionFile(entry: SessionEntry, selector: { subagentId?: string; sessionFile?: string }): string {
	if (selector.subagentId) {
		const sessionFile =
			entry.subagentSnapshots.get(selector.subagentId)?.sessionFile ??
			entry.transcriptSessionFilesBySubagentId.get(selector.subagentId);
		if (!sessionFile) {
			throw new Error(`Unknown subagent or session file unavailable: ${selector.subagentId}`);
		}
		return sessionFile;
	}
	if (selector.sessionFile) {
		if (hasTranscriptSessionFile(entry, selector.sessionFile)) return selector.sessionFile;
		throw new Error("Unknown subagent session file");
	}
	throw new Error("getSubagentMessages requires subagentId or sessionFile");
}

/** Port of the RPC transcript reader: byte-offset paging over the subagent's .jsonl. */
async function readSubagentTranscript(sessionFile: string, fromByte = 0): Promise<SubagentMessagesResult> {
	let startByte = Number.isFinite(fromByte) ? Math.max(0, Math.trunc(fromByte)) : 0;
	const file = Bun.file(sessionFile);
	let size: number;
	try {
		({ size } = await stat(sessionFile));
	} catch (err) {
		if (!isEnoent(err)) throw err;
		return { sessionFile, fromByte: startByte, nextByte: startByte, reset: false, entries: [], messages: [] };
	}
	let reset = false;
	if (startByte > size) {
		startByte = 0;
		reset = true;
	}
	const text = startByte >= size ? "" : await file.slice(startByte).text();
	const lastNewline = text.lastIndexOf("\n");
	const completeText = lastNewline >= 0 ? text.slice(0, lastNewline + 1) : "";
	const entries = completeText.length > 0 ? parseSessionEntries(completeText) : [];
	const nextByte = startByte + Buffer.byteLength(completeText, "utf8");
	return {
		sessionFile,
		fromByte: startByte,
		nextByte,
		reset,
		entries,
		messages: entries.filter(isSessionMessageEntry).map(entry => entry.message),
	};
}

// ---------------------------------------------------------------------------
// Session registry: Map<handle, SessionEntry>. The handle is server-assigned
// at creation and stable for the session's lifetime — it, not the agent
// sessionId, is the multiplexing key. Per-session AgentRegistry/EventBus/
// SessionManager (Phase 1 factory) keeps subagent rosters namespaced per
// session; ui_request pending maps and the subagent mirror live here too.
// ---------------------------------------------------------------------------

interface SessionEntry {
	handle: string;
	cwd: string;
	session: AgentSession;
	agentRegistry: AgentRegistry;
	eventBus: EventBus;
	slashRuntime: SlashCommandRuntime;
	pendingUiRequests: Map<
		string,
		{ sockets: Set<Ws>; resolve: (value: unknown) => void; reject: (err: Error) => void }
	>;
	subagentSnapshots: Map<string, SubagentSnapshot>;
	transcriptSessionFilesBySubagentId: Map<string, string>;
	staleSubagentIds: Set<string>;
}

const sessions = new Map<string, SessionEntry>();
let nextHandle = 1;
/** Most-recently-created live session: the WS-open auto-attach target. */
let lastHandle: string | null = null;

function buildStateSnapshot(session: AgentSession): WebSessionState {
	return {
		model: session.model,
		thinkingLevel: session.thinkingLevel,
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		interruptMode: session.interruptMode,
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		sessionName: session.sessionName,
		autoCompactionEnabled: session.autoCompactionEnabled,
		autoRetryEnabled: session.autoRetryEnabled,
		messageCount: session.messages.length,
		queuedMessageCount: session.queuedMessageCount,
		todoPhases: session.getTodoPhases(),
		systemPrompt: session.systemPrompt,
		dumpTools: session.agent.state.tools.map(tool => ({
			name: tool.name,
			description: tool.description,
			parameters: isZodSchema(tool.parameters) ? zodToWireSchema(tool.parameters) : tool.parameters,
			examples: tool.examples,
		})),
		contextUsage: session.getContextUsage(),
	};
}

async function broadcastState(entry: SessionEntry, withStats = false): Promise<void> {
	const stats = withStats ? entry.session.getSessionStats() : undefined;
	broadcastTo(entry.handle, { type: "state", state: buildStateSnapshot(entry.session), stats });
}

async function broadcastHistory(entry: SessionEntry): Promise<void> {
	broadcastTo(entry.handle, { type: "history", messages: entry.session.messages });
}

async function broadcastAvailableCommands(entry: SessionEntry): Promise<void> {
	broadcastTo(entry.handle, { type: "available_commands", commands: await buildAvailableSlashCommands(entry.session) });
}

function wireSession(entry: SessionEntry): void {
	const { session, eventBus } = entry;
	// session.subscribe covers the entire AgentSessionEvent union — the same
	// frames the RPC child emitted onSessionEvent.
	session.subscribe(event => {
		broadcastTo(entry.handle, { type: "event", event });
		// Tokens/cost/context/queue counts all change at turn end.
		if (event.type === "agent_end") void broadcastState(entry, true).catch(() => {});
	});
	eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		handleSubagentLifecycle(entry, data as SubagentLifecyclePayload);
	});
	eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
		handleSubagentProgress(entry, data as SubagentProgressPayload);
	});
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
		output: text => notifyEvent(entry, text),
		refreshCommands: () => broadcastAvailableCommands(entry),
		// No plugin-state reloader is wired in the web host; re-advertising the
		// command list is the observable part of the reload.
		reloadPlugins: () => broadcastAvailableCommands(entry),
		notifyTitleChanged: () => broadcastState(entry),
		notifyConfigChanged: () => broadcastState(entry),
	};
}

async function createSession(sessionCwd: string): Promise<SessionEntry> {
	const agentRegistry = new AgentRegistry();
	const eventBus = new EventBus();
	const result = await createAgentSession({
		cwd: sessionCwd,
		agentDir,
		authStorage,
		modelRegistry,
		settings,
		sessionManager: SessionManager.create(sessionCwd),
		agentRegistry,
		eventBus,
		hasUI: true,
	});
	const entry: SessionEntry = {
		handle: `s${nextHandle++}`,
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
	};
	entry.slashRuntime = buildSlashRuntime(entry);
	// Feeds the tool UI context; without hasUI the ask tool never registers.
	result.setToolUIContext(buildUiContext(entry), true);
	wireSession(entry);
	return entry;
}

function registerSession(entry: SessionEntry): void {
	sessions.set(entry.handle, entry);
	lastHandle = entry.handle;
}

try {
	registerSession(await createSession(cwd));
} catch (err) {
	console.error("Failed to start agent session:", err);
	process.exit(1);
}

type Images = ImageContent[] | undefined;

// Fire-and-forget: prompt resolves at turn end, so awaiting it would block
// the relay. Failures surface as an error frame.
function fireAndForgetPrompt(entry: SessionEntry, text: string, images: Images): void {
	entry.session.prompt(text, { images }).catch(err => broadcast({ type: "error", error: String(err) }));
}

/** Runs builtin / commands (/export, /compact, …); returns true when the input was consumed. */
async function runBuiltinSlashCommand(entry: SessionEntry, text: string, images: Images): Promise<boolean> {
	const builtinResult = await executeAcpBuiltinSlashCommand(text, entry.slashRuntime);
	if (builtinResult === false) return false;
	if ("prompt" in builtinResult) fireAndForgetPrompt(entry, builtinResult.prompt, images);
	return true;
}

// Read-only calls skip the post-mutation state broadcast.
const READ_ONLY: Partial<Record<WebMethodName, true>> = {
	getSessionStats: true,
	getAvailableModels: true,
	getBranchMessages: true,
	getLoginProviders: true,
	getSubagents: true,
	getSubagentMessages: true,
};

// Calls that replace the transcript; every tab resyncs, not just the requester.
const HISTORY_RELOAD: Partial<Record<WebMethodName, true>> = { newSession: true, switchSession: true, branch: true };

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
			await broadcastAvailableCommands(entry);
		}
		return { cancelled: !ok };
	}
	if (kind === "switchSession") {
		const ok = await session.switchSession(arg as string);
		if (ok) {
			clearSubagents(entry);
			await broadcastAvailableCommands(entry);
		}
		return { cancelled: !ok };
	}
	const result = await session.branch(arg as string);
	if (!result.cancelled) {
		clearSubagents(entry);
		await broadcastAvailableCommands(entry);
	}
	return { text: result.selectedText, cancelled: result.cancelled };
}

/**
 * Steer target: a registered agent with a live, running session. Parked refs have session null.
 * Task subagents register in AgentRegistry.global() (executor.ts hardcodes it), NOT the session's
 * private registry — that one only ever holds "Main". The per-session allowlist is the lifecycle
 * mirror: an id absent from subagentSnapshots belongs to another session (or no session) and is rejected.
 */
function liveSubagentSession(entry: SessionEntry, agentId: string, op: "steer" | "abort"): AgentSession {
	if (!entry.subagentSnapshots.has(agentId)) throw new Error(`Cannot ${op} agent ${agentId}: no such agent`);
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
	if (!entry.subagentSnapshots.has(agentId)) throw new Error(`Cannot abort agent ${agentId}: no such agent`);
	const manager = entry.session.asyncJobManager;
	const job = manager?.getJob(agentId);
	if (job) {
		if (job.status === "running") {
			if (!manager!.cancel(agentId)) throw new Error(`Cannot abort agent ${agentId}: job already settled`);
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

const METHODS: Record<WebMethodName, (entry: SessionEntry, args: unknown[]) => Promise<unknown>> = {
	prompt: async (entry, a) => {
		const text = a[0] as string;
		const images = a[1] as Images;
		if (await runBuiltinSlashCommand(entry, text, images)) return undefined;
		fireAndForgetPrompt(entry, text, images);
		return undefined;
	},
	steer: (entry, a) => entry.session.steer(a[0] as string, a[1] as Images),
	followUp: (entry, a) => entry.session.followUp(a[0] as string, a[1] as Images),
	abort: entry => entry.session.abort({ reason: USER_INTERRUPT_LABEL }),
	abortAndPrompt: async (entry, a) => {
		await entry.session.abort({ reason: USER_INTERRUPT_LABEL });
		fireAndForgetPrompt(entry, a[0] as string, a[1] as Images);
	},
	newSession: (entry, a) => changeSession(entry, "newSession", a[0] as string | undefined),
	switchSession: (entry, a) => changeSession(entry, "switchSession", a[0] as string),
	branch: (entry, a) => changeSession(entry, "branch", a[0] as string),
	compact: (entry, a) => entry.session.compact(a[0] as string | undefined),
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
	bash: (entry, a) => entry.session.executeBash(a[0] as string),
	abortBash: async entry => {
		entry.session.abortBash();
	},
	getSessionStats: async entry => entry.session.getSessionStats(),
	exportHtml: async (entry, a) => ({ path: await entry.session.exportToHtml(a[0] as string | undefined) }),
	getBranchMessages: async entry => entry.session.getUserMessagesForBranching(),
	getLoginProviders: async () =>
		getOAuthProviders().map(provider => ({
			id: provider.id,
			name: provider.name,
			available: provider.available,
			authenticated: authStorage.hasAuth(provider.id),
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
		await liveSubagentSession(entry, a[0] as string, "steer").steer(a[1] as string);
	},
	subagentAbort: async (entry, a) => {
		await abortSubagent(entry, a[0] as string);
	},
};

// Login callbacks are streaming (open_url + manual code input), so login is
// special-cased in handleCommand with the requesting socket in scope.
// Pending code inputs stay per-socket and are rejected on login settle, on
// socket close, on the attached session's close, and on shutdown.
const pendingCodeInputs = new Map<
	string,
	{ ws: Ws; resolve: (code: string) => void; reject: (err: Error) => void }
>();
let nextLoginRequestId = 1;

async function loginWithCallbacks(ws: Ws, entry: SessionEntry, providerId: string): Promise<unknown> {
	const knownProvider = getOAuthProviders().find(p => p.id === providerId);
	if (!knownProvider) throw new Error(`Unknown OAuth provider: ${providerId}`);
	// Track whether onAuth has fired. Providers that require interactive input
	// before a browser URL cannot be satisfied by the web UI; after onAuth,
	// prompt input is the pasted OAuth code/redirect URL path.
	let authEmitted = false;
	try {
		await authStorage.login(providerId as Parameters<AuthStorage["login"]>[0], {
			onAuth: info => {
				authEmitted = true;
				send(ws, { type: "login_url", url: info.url, launchUrl: info.launchUrl, instructions: info.instructions });
			},
			onProgress: message => notifyEvent(entry, message),
			onPrompt: prompt => {
				if (!authEmitted) {
					return Promise.reject(
						new Error(
							`Provider '${providerId}' requires interactive prompts ` +
								"which are not supported in the web UI. Use the terminal UI to log in.",
						),
					);
				}
				const requestId = `lr${nextLoginRequestId++}`;
				const { promise, resolve, reject } = Promise.withResolvers<string>();
				pendingCodeInputs.set(requestId, { ws, resolve, reject });
				send(ws, { type: "login_code_request", requestId, title: prompt.message, placeholder: prompt.placeholder });
				return promise;
			},
		});
		// Provider-scoped online refresh so the just-persisted credential
		// re-runs discovery instead of reusing a fresh authoritative cache row.
		await modelRegistry.refreshProvider(providerId, "online");
		await broadcastAvailableCommands(entry);
		return { providerId };
	} finally {
		// Reject this socket's leftover code inputs (already-resolved entries
		// were deleted by the login_code handler, so only stragglers remain).
		for (const [id, p] of pendingCodeInputs) {
			if (p.ws === ws) {
				p.reject(new Error("login ended"));
				pendingCodeInputs.delete(id);
			}
		}
	}
}

const LIST_FILES_SKIP: Record<string, true> = { ".git": true, node_modules: true };
const LIST_FILES_CEILING = 10_000;

async function listFiles(query: string, limit: number): Promise<string[]> {
	const entries: string[] = [];
	const walk = async (dir: string, prefix: string): Promise<void> => {
		if (entries.length >= LIST_FILES_CEILING) return;
		let dirents;
		try {
			dirents = await readdir(dir, { withFileTypes: true });
		} catch {
			return; // unreadable directory: skip
		}
		for (const d of dirents) {
			if (entries.length >= LIST_FILES_CEILING) return;
			if (LIST_FILES_SKIP[d.name]) continue;
			const rel = prefix ? `${prefix}/${d.name}` : d.name;
			if (d.isDirectory()) await walk(path.join(dir, d.name), rel);
			else entries.push(rel);
		}
	};
	await walk(cwd, "");
	const q = query.toLowerCase();
	return entries.filter(f => f.toLowerCase().includes(q)).slice(0, limit);
}

/** Attach a socket and push the session priming sequence, in contract order. */
function attachSocket(ws: Ws, entry: SessionEntry): void {
	ws.data.attached = entry.handle;
	send(ws, { type: "attached", sessionId: entry.handle });
	sendScoped(ws, entry.handle, { type: "history", messages: entry.session.messages });
	sendScoped(ws, entry.handle, {
		type: "state",
		state: buildStateSnapshot(entry.session),
		stats: entry.session.getSessionStats(),
	});
	void buildAvailableSlashCommands(entry.session)
		.then(commands => sendScoped(ws, entry.handle, { type: "available_commands", commands }))
		.catch(err => console.error("Failed to build available commands:", err));
}

/**
 * Dispose a live session and cut it out of the registry. Sockets attached to
 * it are detached (never closed); its pending ui_requests and the pending
 * login code inputs of those sockets are rejected.
 */
async function closeSession(entry: SessionEntry, reason: string): Promise<void> {
	entry.session.beginDispose();
	await entry.session.dispose().catch(() => {});
	rejectEntryUiRequests(entry, reason);
	for (const [id, p] of pendingCodeInputs) {
		if (p.ws.data.attached === entry.handle) {
			p.reject(new Error(reason));
			pendingCodeInputs.delete(id);
		}
	}
	for (const ws of sockets) if (ws.data.attached === entry.handle) ws.data.attached = null;
	sessions.delete(entry.handle);
	if (lastHandle === entry.handle) lastHandle = [...sessions.keys()].at(-1) ?? null;
}

/** The session this socket's call/login_code/ui_response commands route to. */
function attachedEntry(ws: Ws): SessionEntry | undefined {
	return ws.data.attached ? sessions.get(ws.data.attached) : undefined;
}

async function handleCommand(ws: Ws, raw: string | Buffer): Promise<void> {
	let cmd: ClientCommand;
	try {
		cmd = JSON.parse(String(raw)) as ClientCommand;
	} catch {
		send(ws, { type: "error", error: "Malformed command frame" });
		return;
	}
	try {
		switch (cmd.type) {
			case "call": {
				const entry = attachedEntry(ws);
				if (!entry) throw new Error("Not attached to a session");
				const method = METHODS[cmd.method];
				if (!method) throw new Error(`Unknown method: ${cmd.method}`);
				const data =
					cmd.method === "login"
						? await loginWithCallbacks(ws, entry, cmd.args?.[0] as string)
						: await method(entry, cmd.args ?? []);
				// Post-mutation resync is best-effort: the mutation already
				// succeeded, so a resync failure must not fail the call.
				const resync = async () => {
					try {
						if (HISTORY_RELOAD[cmd.method]) await broadcastHistory(entry);
						if (HISTORY_RELOAD[cmd.method] || !READ_ONLY[cmd.method]) await broadcastState(entry);
					} catch (err) {
						console.error("Post-mutation resync failed:", err);
						broadcast({ type: "error", error: `resync failed: ${String(err)}` });
					}
				};
				if (HISTORY_RELOAD[cmd.method]) {
					// Resync BEFORE the call_result: picker success UI (notices,
					// modal close) must run after the transcript is replaced.
					await resync();
					sendScoped(ws, entry.handle, { type: "call_result", id: cmd.id, ok: true, data });
				} else {
					sendScoped(ws, entry.handle, { type: "call_result", id: cmd.id, ok: true, data });
					await resync();
				}
				break;
			}
			case "login_code": {
				const pending = pendingCodeInputs.get(cmd.requestId);
				if (pending) {
					pendingCodeInputs.delete(cmd.requestId);
					pending.resolve(cmd.code);
				}
				break;
			}
			case "ui_response": {
				const entry = attachedEntry(ws);
				const pending = entry?.pendingUiRequests.get(cmd.id);
				if (entry && pending) {
					entry.pendingUiRequests.delete(cmd.id);
					if (cmd.error !== undefined) pending.reject(new Error(cmd.error));
					else pending.resolve(cmd.result);
				}
				break;
			}
			case "list_sessions": {
				const infos = await listAllSessions();
				const sessionsList: SessionListEntry[] = infos
					.map(i => ({
						path: i.path,
						id: i.id,
						name: i.title,
						cwd: i.cwd,
						modifiedAt: i.modified.getTime(),
						messageCount: i.messageCount,
					}))
					.sort((x, y) => y.modifiedAt - x.modifiedAt)
					.slice(0, 200);
				send(ws, { type: "sessions", sessions: sessionsList });
				break;
			}
			case "list_files": {
				send(ws, { type: "files", files: await listFiles(cmd.query, cmd.limit ?? 50) });
				break;
			}
			case "create_session": {
				try {
					const entry = await createSession(cmd.cwd ?? cwd);
					registerSession(entry);
					attachSocket(ws, entry);
				} catch (err) {
					// Factory failure leaves the socket on its previous session.
					send(ws, { type: "error", error: `create_session failed: ${String(err)}` });
				}
				break;
			}
			case "attach": {
				const entry = sessions.get(cmd.sessionId);
				if (!entry) send(ws, { type: "error", error: `Unknown session: ${cmd.sessionId}` });
				else attachSocket(ws, entry);
				break;
			}
			case "detach": {
				ws.data.attached = null;
				break;
			}
			case "close_session": {
				const entry = sessions.get(cmd.sessionId);
				if (!entry) send(ws, { type: "error", error: `Unknown session: ${cmd.sessionId}` });
				else await closeSession(entry, "session closed");
				break;
			}
			case "list_live_sessions": {
				send(ws, {
					type: "live_sessions",
					sessions: [...sessions.values()].map(entry => {
						const { session } = entry;
						const live: LiveSessionEntry = {
							sessionId: entry.handle,
							name: session.sessionName,
							cwd: entry.cwd,
							thinkingLevel: session.thinkingLevel,
							contextUsage: session.getContextUsage(),
							messageCount: session.messages.length,
							isStreaming: session.isStreaming,
						};
						if (session.model) live.model = `${session.model.provider}/${session.model.id}`;
						return live;
					}),
					process: {
						rssBytes: process.memoryUsage().rss,
						uptimeSec: process.uptime(),
						sessionCount: sessions.size,
					},
				});
				break;
			}
			default:
				throw new Error(`Unknown command: ${JSON.stringify(cmd)}`);
		}
	} catch (err) {
		if (cmd.type === "call") {
			const entry = attachedEntry(ws);
			if (entry) sendScoped(ws, entry.handle, { type: "call_result", id: cmd.id, ok: false, error: String(err) });
			else send(ws, { type: "error", error: String(err) });
		} else {
			send(ws, { type: "error", error: String(err) });
		}
	}
}

// /download streams a server-side file (used by /export). The only trust
// boundary on this unauthenticated server: the canonical (realpath) target
// must live inside the system temp dir, the agent cwd (where bare-filename
// exports land), or a live session file's directory. Canonicalizing both
// sides closes symlink escapes that a lexical prefix check would miss.
async function canonicalRoots(): Promise<string[]> {
	const roots = [os.tmpdir(), cwd];
	for (const entry of sessions.values()) {
		const sessionFile = entry.session.sessionFile;
		if (sessionFile) roots.push(path.dirname(sessionFile));
	}
	const out: string[] = [];
	for (const root of roots) {
		out.push(await realpath(root).catch(() => root));
	}
	return out;
}

function isInside(resolved: string, roots: string[]): boolean {
	return roots.some(root => {
		const rel = path.relative(root, resolved);
		return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
	});
}

const server = Bun.serve<SocketData>({
	port: 4711,
	async fetch(req, srv) {
		const url = new URL(req.url);
		if (url.pathname === "/ws") {
			if (srv.upgrade(req, { data: { attached: null } })) return;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		if (url.pathname === "/download") {
			const requested = url.searchParams.get("path");
			if (!requested) return new Response("Missing path", { status: 400 });
			// Relative export paths are written by the agent into its cwd.
			const canonical = await realpath(path.resolve(cwd, requested)).catch(() => null);
			if (!canonical) return new Response("Not found", { status: 404 });
			const fileStat = await stat(canonical).catch(() => null);
			if (!fileStat?.isFile()) return new Response("Not found", { status: 404 });
			if (!isInside(canonical, await canonicalRoots())) return new Response("Forbidden", { status: 403 });
			return new Response(Bun.file(canonical));
		}
		const file = Bun.file(url.pathname === "/" ? "dist/index.html" : `dist${url.pathname}`);
		if (!(await file.exists())) return new Response("Not found", { status: 404 });
		return new Response(file);
	},
	websocket: {
		open(ws) {
			sockets.add(ws);
			// Auto-attach to the most-recently-created live session: a bare WS
			// open reproduces the single-session priming sequence unchanged.
			const entry = lastHandle ? sessions.get(lastHandle) : undefined;
			if (entry) attachSocket(ws, entry);
		},
		close(ws) {
			// Detach only: sessions outlive sockets.
			sockets.delete(ws);
			ws.data.attached = null;
			for (const [id, p] of pendingCodeInputs) {
				if (p.ws === ws) {
					p.reject(new Error("socket closed"));
					pendingCodeInputs.delete(id);
				}
			}
			// A UI request dies only when every socket it was shown to is gone.
			for (const entry of sessions.values()) {
				for (const [id, p] of entry.pendingUiRequests) {
					p.sockets.delete(ws);
					if (p.sockets.size === 0) {
						p.reject(new Error("socket closed"));
						entry.pendingUiRequests.delete(id);
					}
				}
			}
		},
		message(ws, raw) {
			void handleCommand(ws, raw);
		},
	},
});

console.log(`omp-web listening on http://localhost:${server.port}`);

// Graceful shutdown: reject pending dialogs/code inputs, then dispose every
// session (beginDispose is the sync admission barrier; dispose is idempotent).
let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	for (const entry of sessions.values()) rejectEntryUiRequests(entry, "server shutting down");
	for (const [id, p] of pendingCodeInputs) {
		p.reject(new Error("server shutting down"));
		pendingCodeInputs.delete(id);
	}
	for (const entry of sessions.values()) {
		entry.session.beginDispose();
		await entry.session.dispose().catch(() => {});
	}
	sessions.clear();
	server.stop();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
