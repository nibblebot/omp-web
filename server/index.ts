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
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionAskDialogResultItem,
	type ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import {
	COLLAB_PROMPT_MESSAGE_TYPE,
	type CollabPromptDetails,
	type CollabUiRequestDraft,
	type CollabUiSelectItem,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { MODEL_ROLE_IDS } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { SETTINGS_SCHEMA, type SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings-schema";
import { getAvailableThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { InspectImageMode } from "@oh-my-pi/pi-coding-agent/utils/inspect-image-mode";
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
import { daemonClientForProject } from "@oh-my-pi/pi-coding-agent/launch/client";
import type { DaemonSnapshot } from "@oh-my-pi/pi-coding-agent/launch/protocol";
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
	DaemonInfo,
	CollabParticipantInfo,
	CollabWireStatus,
} from "../src/protocol";
import { applySettingSideEffects, buildSettingsModel, coerceSettingValue } from "./settings-model";
import {
	CollabHostAdapter,
	type CollabAgentRef,
	type CollabHostStatus,
	type CollabSessionPort,
} from "./collab-host";
import { createRelay, type RelayHandle, type SocketData } from "./collab-relay";

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

type Ws = ServerWebSocket<SocketData>;

const sockets = new Set<Ws>();

// ---------------------------------------------------------------------------
// Collab relay (Slice A): rooms that forward opaque AES-GCM envelopes between
// a per-session host adapter and real omp TUI guests (`omp join <link>`).
// Relay sockets are typed { kind: "relay" } and are NEVER added to `sockets`.
// ---------------------------------------------------------------------------

const relayMaxGuests = Number(Bun.env.OMP_WEB_COLLAB_MAX_GUESTS ?? 64);
const relay: RelayHandle = createRelay({ maxGuests: relayMaxGuests });

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
	for (const ws of sockets) {
		if (ws.data.kind === "web" && ws.data.attached === handle) ws.send(data);
	}
}

/** Surface operator-facing text as the existing notice event frame. */
function notifyEvent(entry: SessionEntry, message: string, level: "info" | "warning" | "error" = "info"): void {
	broadcastTo(entry.handle, { type: "event", event: { type: "notice", level, message } });
}

// Phase 11: AbortControllers for in-flight runEphemeralTurn calls, keyed by
// (session, streamId). abortEphemeral cancels via the SDK signal — the same
// side-channel pattern bash/python use, but those have dedicated SDK aborters.
const ephemeralAborts = new Map<SessionEntry, Map<number, AbortController>>();

function setEphemeralAbort(entry: SessionEntry, streamId: number, controller: AbortController): void {
	let byStream = ephemeralAborts.get(entry);
	if (!byStream) ephemeralAborts.set(entry, (byStream = new Map()));
	byStream.set(streamId, controller);
}

function clearEphemeralAbort(entry: SessionEntry, streamId: number): void {
	ephemeralAborts.get(entry)?.delete(streamId);
}

// ---------------------------------------------------------------------------
// ExtensionUIContext (plan §1.7): the dialog subset round-trips over the
// socket as ui_request/ui_response frames; terminal-only surface is stubbed.
// Pending requests live on the owning SessionEntry, target only that
// session's attached sockets, and are rejected when every targeted socket has
// closed and on session close / server shutdown.
// ---------------------------------------------------------------------------

let nextUiRequestId = 1;

/**
 * Sentinel for the collab ui preference: the collab channel went away
 * mid-request (no writable guest at send time, teardown, abort) — the caller
 * falls through to the web-socket path below.
 */
const COLLAB_UI_FALLTHROUGH = Symbol("collab-ui-fallthrough");

/**
 * The ExtensionUIContext dialog subset, answered by a writable collab guest
 * FIRST (mirroring the TUI's collab-host preference in #runGuestDialog); when
 * no writable guest is attached the request falls through to the web sockets.
 */
function uiRequest(entry: SessionEntry, method: string, params: unknown): Promise<unknown> {
	const adapter = entry.collab.adapter;
	if (adapter?.isLive && adapter.writableGuestCount > 0) {
		return uiRequestViaCollab(entry, method, params).then(value => {
			if (value === COLLAB_UI_FALLTHROUGH) return webUiRequest(entry, method, params);
			return value;
		});
	}
	return webUiRequest(entry, method, params);
}

/** The pre-existing web-socket dialog path (one pending request per entry). */
function webUiRequest(entry: SessionEntry, method: string, params: unknown): Promise<unknown> {
	const targets = new Set<Ws>();
	for (const ws of sockets) {
		if (ws.data.kind === "web" && ws.data.attached === entry.handle) targets.add(ws);
	}
	if (targets.size === 0) return Promise.reject(new Error("No connected client to answer the UI request"));
	const id = `ui${nextUiRequestId++}`;
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	entry.pendingUiRequests.set(id, { sockets: targets, resolve, reject });
	broadcastTo(entry.handle, { type: "ui_request", id, method, params });
	return promise;
}

// Params shapes are fixed by buildUiContext's uiRequest call sites below
// (one object literal per method), so a single named cast at the mapper
// boundary is safe; the same objects ride the wire as the web ui_request.
interface SelectDialogParams {
	title: string;
	options: CollabUiSelectItem[];
}
interface ConfirmDialogParams {
	title: string;
	message?: string;
}
interface InputDialogParams {
	title: string;
	placeholder?: string;
}
interface EditorDialogParams {
	title: string;
	prefill?: string;
}
interface AskDialogParams {
	questions: ExtensionAskDialogQuestion[];
}

/** Map one dialog method to its collab wire request; null = not a collab surface. */
function mapUiMethodToCollab(method: string, params: unknown): CollabUiRequestDraft | null {
	switch (method) {
		case "select": {
			// Shape fixed by buildUiContext's select call site.
			const p = params as SelectDialogParams;
			return { kind: "select", title: p.title, options: p.options };
		}
		case "confirm": {
			// Shape fixed by buildUiContext's confirm call site.
			const p = params as ConfirmDialogParams;
			return { kind: "select", title: p.title, options: ["Yes", "No"] };
		}
		case "input": {
			// Shape fixed by buildUiContext's input call site.
			const p = params as InputDialogParams;
			return { kind: "editor", title: p.title, prefill: p.placeholder };
		}
		case "editor": {
			// Shape fixed by buildUiContext's editor call site.
			const p = params as EditorDialogParams;
			return { kind: "editor", title: p.title, prefill: p.prefill };
		}
		default:
			return null;
	}
}

/**
 * One collab dialog round-trip. Resolves with the guest's value (undefined =
 * genuine guest cancel) or COLLAB_UI_FALLTHROUGH when the collab channel is
 * unavailable.
 */
async function collabAsk(adapter: CollabHostAdapter, draft: CollabUiRequestDraft): Promise<unknown> {
	const request = adapter.requestGuestUi(draft);
	if (!request) return COLLAB_UI_FALLTHROUGH;
	const result = await request;
	if (result.kind === "unavailable") return COLLAB_UI_FALLTHROUGH;
	return result.value;
}

/**
 * Sequential per-question askDialog over the wire, mirroring the TUI's
 * #runGuestAskDialog minus the "Chat about this" escape. `undefined` is a
 * genuine guest cancel that aborts the whole dialog; COLLAB_UI_FALLTHROUGH
 * routes back to the web sockets.
 */
async function askDialogViaCollab(adapter: CollabHostAdapter, questions: ExtensionAskDialogQuestion[]): Promise<unknown> {
	const results: ExtensionAskDialogResultItem[] = [];
	for (let index = 0; index < questions.length; index++) {
		const q = questions[index];
		const selected = new Set<string>();
		let customInput: string | undefined;
		const baseOptions: CollabUiSelectItem[] = q.options.map(o =>
			o.description?.trim() ? { label: o.label, description: o.description.trim() } : o.label,
		);
		if (q.multi) {
			while (true) {
				const checkedIndices = q.options
					.map((option, i) => (selected.has(option.label) ? i : -1))
					.filter(i => i >= 0);
				const choice = await collabAsk(adapter, {
					kind: "select",
					title: q.question,
					options: [...baseOptions, "Other (type your own)", "Next →"],
					selectionMarker: "checkbox",
					checkedIndices,
					markableCount: q.options.length,
				});
				if (choice === COLLAB_UI_FALLTHROUGH || choice === undefined) return choice;
				if (choice === "Next →") break;
				if (choice === "Other (type your own)") {
					const input = await collabAsk(adapter, { kind: "editor", title: q.question, prefill: "" });
					if (input === COLLAB_UI_FALLTHROUGH) return input;
					// Guest cancelled the Other editor: back to the option list.
					if (input === undefined) continue;
					customInput = input as string;
					break;
				}
				if (selected.has(choice as string)) selected.delete(choice as string);
				else selected.add(choice as string);
			}
		} else {
			while (true) {
				const choice = await collabAsk(adapter, {
					kind: "select",
					title: q.question,
					options: [...baseOptions, "Other (type your own)"],
				});
				if (choice === COLLAB_UI_FALLTHROUGH || choice === undefined) return choice;
				if (choice === "Other (type your own)") {
					const input = await collabAsk(adapter, { kind: "editor", title: q.question, prefill: "" });
					if (input === COLLAB_UI_FALLTHROUGH) return input;
					// Guest cancelled the Other editor: re-show the option list.
					if (input === undefined) continue;
					customInput = input as string;
				} else {
					selected.add(choice as string);
				}
				break;
			}
		}
		results.push({
			id: q.id ?? String(index),
			question: q.question,
			options: q.options.map(o => o.label),
			multi: !!q.multi,
			selectedOptions: q.options.map(o => o.label).filter(label => selected.has(label)),
			customInput,
		});
	}
	return { kind: "submit", results };
}

/** Dialog dispatch through a live collab adapter; COLLAB_UI_FALLTHROUGH when unanswerable there. */
async function uiRequestViaCollab(entry: SessionEntry, method: string, params: unknown): Promise<unknown> {
	const adapter = entry.collab.adapter;
	if (!adapter?.isLive) return COLLAB_UI_FALLTHROUGH;
	if (method === "askDialog") {
		// Shape fixed by buildUiContext's askDialog call site.
		const p = params as AskDialogParams;
		return askDialogViaCollab(adapter, p.questions);
	}
	const draft = mapUiMethodToCollab(method, params);
	if (!draft) return COLLAB_UI_FALLTHROUGH;
	const value = await collabAsk(adapter, draft);
	if (value === COLLAB_UI_FALLTHROUGH) return value;
	// confirm answers with Yes/No over the wire; the web contract wants a boolean.
	if (method === "confirm") return value === "Yes";
	return value;
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
	entry.onSubagentsChange?.();
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
	// Collab guests mirror the same roster; notify the tap after the mutation.
	entry.onSubagentsChange?.();
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
	/** Collab host state: the live adapter (null when not live) plus the start-in-flight flag. */
	collab: { adapter: CollabHostAdapter | null; starting: boolean };
	/** Fired by the subagent mirror when the roster may have changed (collab agents tap). */
	onSubagentsChange: (() => void) | null;
}

const sessions = new Map<string, SessionEntry>();
let nextHandle = 1;
/** Most-recently-created live session: the WS-open auto-attach target. */
let lastHandle: string | null = null;

/** Resolved model-role assignments via the SDK's getRoleModelCycle (skips unconfigured/unavailable roles). */
function buildModelRoles(session: AgentSession): WebSessionState["modelRoles"] {
	// Canonical built-in order, then any custom roles from settings (deduped).
	const customRoles = Object.keys(session.settings.getModelRoles()).filter(
		role => !(MODEL_ROLE_IDS as readonly string[]).includes(role),
	);
	const cycle = session.getRoleModelCycle([...MODEL_ROLE_IDS, ...customRoles]);
	if (!cycle) return undefined;
	return cycle.models.map(entry => ({ role: entry.role, provider: entry.model.provider, id: entry.model.id }));
}

function buildStateSnapshot(session: AgentSession): WebSessionState {
	return {
		model: session.model,
		modelRoles: buildModelRoles(session),
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
		// Phase 9: cheap sync getters — refreshed on every state broadcast.
		goalModeState: session.getGoalModeState(),
		planModeEnabled: session.getPlanModeState()?.enabled ?? false,
		fastModeEnabled: session.isFastModeEnabled(),
		computerToolEnabled: session.getActiveToolNames().includes("computer"),
		inspectImageMode: session.inspectImageState().mode,
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

function liveSessionSnapshot(): LiveSessionEntry[] {
	return [...sessions.values()].map(entry => {
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
	});
}

function processStatsSnapshot(): ProcessStats {
	return {
		rssBytes: process.memoryUsage().rss,
		uptimeSec: process.uptime(),
		sessionCount: sessions.size,
	};
}

function broadcastLiveSessions(): void {
	broadcast({ type: "live_sessions", sessions: liveSessionSnapshot() });
}

const DAEMON_POLL_MS = 3000;
let daemonPoll: ReturnType<typeof setInterval> | undefined;

function daemonInfo(projectDir: string, snap: DaemonSnapshot): DaemonInfo {
	return {
		name: snap.name,
		id: snap.id,
		projectDir,
		state: snap.state,
		pid: snap.pid,
		createdAt: snap.createdAt,
		startedAt: snap.startedAt,
		readyAt: snap.readyAt,
		exitedAt: snap.exitedAt,
		exitCode: snap.exitCode,
		exitReason: snap.exitReason,
		restartCount: snap.restartCount,
		outputBytes: snap.outputBytes,
		owner: snap.owner,
		persist: snap.persist,
		detached: snap.detached,
	};
}

/**
 * Poll every project's daemon broker (server cwd + each live session's cwd)
 * and broadcast the merged roster every tick. A change-gate would strand
 * clients that connect between broadcasts (or miss one frame): the roster is
 * small (~2.5 KB) and the tick cadence is 3s, so re-broadcasting unconditionally
 * self-heals late joins and dropped frames. On broker failure the empty roster
 * is broadcast, and the next successful tick restores the real one.
 */
async function refreshDaemons(): Promise<void> {
	const dirs = new Set<string>([cwd]);
	for (const entry of sessions.values()) if (entry.cwd) dirs.add(entry.cwd);
	const merged = new Map<string, DaemonInfo>();
	for (const dir of dirs) {
		try {
			const client = await daemonClientForProject(dir);
			const result = await client.request({ op: "list" });
			// Daemon names are unique per project dir only; key by
			// projectDir+name so same-named daemons in different projects both
			// reach the roster (the web client uses the same identity).
			if (result.op === "list")
				for (const snap of result.daemons) merged.set(`${dir}\u0000${snap.name}`, daemonInfo(dir, snap));
		} catch {
			// Broker unreachable (not started / shut down): skip this project's roster.
		}
	}
	broadcast({ type: "daemons", daemons: [...merged.values()] });
}

function startDaemonPoll(): void {
	if (daemonPoll) return;
	daemonPoll = setInterval(() => void refreshDaemons(), DAEMON_POLL_MS);
}

function stopDaemonPoll(): void {
	if (!daemonPoll) return;
	clearInterval(daemonPoll);
	daemonPoll = undefined;
}

function wireSession(entry: SessionEntry): void {
	const { session, eventBus } = entry;
	// session.subscribe covers the entire AgentSessionEvent union — the same
	// frames the RPC child emitted onSessionEvent.
	session.subscribe(event => {
		broadcastTo(entry.handle, { type: "event", event });
		// Tokens/cost/context/queue counts all change at turn end.
		if (event.type === "agent_end") void broadcastState(entry, true).catch(() => {});
		// Roster-visible state changed; push a fresh live-sessions snapshot.
		if (event.type === "agent_start" || event.type === "agent_end" || event.type === "message_start" || event.type === "message_end") {
			broadcastLiveSessions();
		}
	});
	eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		handleSubagentLifecycle(entry, data as SubagentLifecyclePayload);
	});
	eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
		handleSubagentProgress(entry, data as SubagentProgressPayload);
	});
}

// ---------------------------------------------------------------------------
// Collab session port (Slice C): the daemon's per-session surface the collab
// host adapter drives — session getters, event/entry/bus taps, guest prompt
// injection, agent roster/control, and transcript resolution.
// ---------------------------------------------------------------------------

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
		subscribe: cb => session.subscribe(cb),
		// Single slot; the adapter restores it (with null) on teardown.
		onEntryAppended: cb => {
			session.sessionManager.onEntryAppended = cb ?? undefined;
		},
		// Both task channels: the same EventBus traffic the subagent mirror taps.
		subscribeBus: cb => {
			const unsubs = [
				entry.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => cb(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data)),
				entry.eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => cb(TASK_SUBAGENT_PROGRESS_CHANNEL, data)),
			];
			return () => {
				for (const unsub of unsubs) unsub();
			};
		},
		subscribeAgents: cb => {
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
					void session.prompt(text ?? "", { streamingBehavior: "steer" }).catch(err => {
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
		resolveTranscriptFile: agentId =>
			agentId === MAIN_AGENT_ID
				? (session.sessionFile ?? null)
				: (entry.transcriptSessionFilesBySubagentId.get(agentId) ?? entry.subagentSnapshots.get(agentId)?.sessionFile ?? null),
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
		maxGuests: relayMaxGuests,
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
		collab: { adapter: null, starting: false },
		onSubagentsChange: null,
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
	broadcastLiveSessions();
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
		.then(async title => {
			if (title && !sessionManager.getSessionName()) {
				await sessionManager.setSessionName(title, "auto");
				broadcastLiveSessions();
			}
		})
		.catch(() => {});
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

// Calls that replace the transcript; every tab resyncs, not just the requester.
// handoff starts a new session server-side; fork rewrites history in place.
const HISTORY_RELOAD: Partial<Record<WebMethodName, true>> = { newSession: true, switchSession: true, branch: true, fork: true, handoff: true };

// Calls that change sidebar-visible session state; every tab's roster resyncs.
const ROSTER_RELOAD: Partial<Record<WebMethodName, true>> = {
	newSession: true,
	switchSession: true,
	branch: true,
	compact: true,
	setModel: true,
	cycleModel: true,
	setThinkingLevel: true,
	cycleThinkingLevel: true,
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

const METHODS: Record<WebMethodName, (entry: SessionEntry, args: unknown[], streamId?: number) => Promise<unknown>> = {
	prompt: async (entry, a) => {
		const text = a[0] as string;
		const images = a[1] as Images;
		if (await runBuiltinSlashCommand(entry, text, images)) return undefined;
		fireAndForgetPrompt(entry, text, images);
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
		fireAndForgetPrompt(entry, a[0] as string, a[1] as Images);
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
		// Persist via the shared Settings singleton (in-process merge +
		// debounced disk write — the TUI's settings.set semantics). Session-
		// managed paths (autoCompact, thinkingLevel) have no schema entry and
		// are applied only through the side-effect switch below.
		if (path in SETTINGS_SCHEMA) {
			settings.set(path as SettingPath, coerced as never);
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
	bash: (entry, a, streamId) =>
		entry.session.executeBash(a[0] as string, chunk => {
			if (streamId !== undefined) broadcastTo(entry.handle, { type: "bash_chunk", id: streamId, text: chunk });
		}, { excludeFromContext: a[1] === true }),
	abortBash: async entry => {
		entry.session.abortBash();
	},
	python: (entry, a, streamId) =>
		entry.session.executePython(a[0] as string, chunk => {
			if (streamId !== undefined) broadcastTo(entry.handle, { type: "python_chunk", id: streamId, text: chunk });
		}, { excludeFromContext: a[1] === true }),
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
	if (ws.data.kind !== "web") return;
	ws.data.attached = entry.handle;
	send(ws, { type: "attached", sessionId: entry.handle });
	sendScoped(ws, entry.handle, { type: "history", messages: entry.session.messages });
	sendScoped(ws, entry.handle, {
		type: "state",
		state: buildStateSnapshot(entry.session),
		stats: entry.session.getSessionStats(),
	});
	// Current collab status, so a client attaching to a live room sees it immediately.
	sendScoped(ws, entry.handle, { type: "collab_status", status: toWireStatus(entry.collab.adapter?.status ?? null) });
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
	// Collab teardown before dispose: stop the adapter (guests get a bye) and
	// destroy the relay room (guests get room-closed + 4001).
	const adapter = entry.collab.adapter;
	const roomId = adapter?.status?.roomId;
	entry.collab.adapter = null;
	if (adapter) await adapter.stop(reason).catch(() => {});
	if (roomId) relay.closeRoom(roomId);
	entry.session.beginDispose();
	await entry.session.dispose().catch(() => {});
	rejectEntryUiRequests(entry, reason);
	for (const [id, p] of pendingCodeInputs) {
		if (p.ws.data.kind === "web" && p.ws.data.attached === entry.handle) {
			p.reject(new Error(reason));
			pendingCodeInputs.delete(id);
		}
	}
	for (const ws of sockets) {
		if (ws.data.kind === "web" && ws.data.attached === entry.handle) ws.data.attached = null;
	}
	sessions.delete(entry.handle);
	if (lastHandle === entry.handle) lastHandle = [...sessions.keys()].at(-1) ?? null;
	broadcastLiveSessions();
}

/** The session this socket's call/login_code/ui_response commands route to. */
function attachedEntry(ws: Ws): SessionEntry | undefined {
	if (ws.data.kind !== "web") return undefined;
	return ws.data.attached ? sessions.get(ws.data.attached) : undefined;
}

async function handleCommand(ws: Ws, raw: string | Buffer): Promise<void> {
	if (ws.data.kind !== "web") return;
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
						: await method(entry, cmd.args ?? [], cmd.streamId);
				// Post-mutation resync is best-effort: the mutation already
				// succeeded, so a resync failure must not fail the call.
				const resync = async () => {
					try {
						if (HISTORY_RELOAD[cmd.method]) await broadcastHistory(entry);
						if (HISTORY_RELOAD[cmd.method] || !READ_ONLY[cmd.method]) await broadcastState(entry);
						if (ROSTER_RELOAD[cmd.method]) broadcastLiveSessions();
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
				send(ws, { type: "live_sessions", sessions: liveSessionSnapshot() });
				break;
			}
			case "get_process_stats": {
				send(ws, { type: "process_stats", process: processStatsSnapshot() });
				break;
			}
			case "collab_start": {
				const entry = attachedEntry(ws);
				if (!entry) throw new Error("Not attached to a session");
				if (entry.collab.starting || entry.collab.adapter) {
					throw new Error("collab already active for this session");
				}
				entry.collab.starting = true;
				broadcastTo(entry.handle, { type: "collab_status", status: { state: "starting" } });
				const adapter = new CollabHostAdapter(buildCollabPort(entry), {
					hostName: Bun.env.OMP_WEB_COLLAB_HOSTNAME ?? (os.userInfo().username || "web"),
					onStatusChange: status => broadcastTo(entry.handle, { type: "collab_status", status: toWireStatus(status) }),
				});
				try {
					await adapter.start(relayBaseUrl());
					entry.collab.adapter = adapter;
				} catch (err) {
					broadcastTo(entry.handle, { type: "collab_status", status: { state: "error", error: String(err) } });
				} finally {
					entry.collab.starting = false;
				}
				break;
			}
			case "collab_stop": {
				const entry = attachedEntry(ws);
				if (!entry) throw new Error("Not attached to a session");
				if (entry.collab.starting) throw new Error("collab is starting");
				const adapter = entry.collab.adapter;
				if (!adapter) throw new Error("collab is not active");
				// Capture the room id BEFORE stop clears the adapter status.
				const roomId = adapter.status?.roomId;
				entry.collab.adapter = null;
				await adapter.stop("collab stopped by web user");
				if (roomId) relay.closeRoom(roomId);
				broadcastTo(entry.handle, { type: "collab_status", status: { state: "off" } });
				break;
			}
			case "daemon_logs": {
				// Per-daemon log tail/head, answered by unicast daemon_logs_result.
				try {
					const client = await daemonClientForProject(cmd.projectDir);
					const result = await client.request({
						op: "logs",
						name: cmd.name,
						lines: cmd.lines,
						head: cmd.head ?? false,
						grep: cmd.grep,
						follow: false,
						timeoutMs: 30_000,
					});
					if (result.op !== "logs") throw new Error("unexpected daemon broker response");
					send(ws, { type: "daemon_logs_result", id: cmd.id, ok: true, text: result.text, cursor: result.cursor, state: result.state });
				} catch (err) {
					send(ws, { type: "daemon_logs_result", id: cmd.id, ok: false, error: String(err) });
				}
				break;
			}
			case "daemon_stop": {
				try {
					const client = await daemonClientForProject(cmd.projectDir);
					const result = await client.request({ op: "stop", name: cmd.name, timeoutMs: cmd.timeoutMs ?? 10_000 });
					if (result.op !== "stop") throw new Error("unexpected daemon broker response");
					send(ws, { type: "daemon_control_result", id: cmd.id, ok: true, daemon: daemonInfo(cmd.projectDir, result.daemon) });
				} catch (err) {
					send(ws, { type: "daemon_control_result", id: cmd.id, ok: false, error: String(err) });
				}
				break;
			}
			case "daemon_restart": {
				try {
					const client = await daemonClientForProject(cmd.projectDir);
					const result = await client.request({ op: "restart", name: cmd.name });
					if (result.op !== "restart") throw new Error("unexpected daemon broker response");
					send(ws, { type: "daemon_control_result", id: cmd.id, ok: true, daemon: daemonInfo(cmd.projectDir, result.daemon) });
				} catch (err) {
					send(ws, { type: "daemon_control_result", id: cmd.id, ok: false, error: String(err) });
				}
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
	const roots = [os.tmpdir(), cwd, process.cwd()];
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
	port: Number(Bun.env.OMP_WEB_PORT ?? 4711),
	async fetch(req, srv) {
		const url = new URL(req.url);
		// Collab relay rooms (/r/<roomId>?role=host|guest) upgrade here; the
		// relay returns false for every other pathname so web handling continues.
		if (relay.handleUpgrade(url, srv, req)) return;
		if (url.pathname === "/ws") {
			if (srv.upgrade(req, { data: { kind: "web", attached: null } })) return;
			return new Response("WebSocket upgrade failed", { status: 400 });
		}
		if (url.pathname === "/download") {
			const requested = url.searchParams.get("path");
			if (!requested) return new Response("Missing path", { status: 400 });
			// Relative export paths are written by the agent into its cwd (or the
			// server's process cwd when the session dir lives there); absolute
			// paths are used as-is.
			const resolved = path.isAbsolute(requested) ? requested : path.resolve(cwd, requested);
			let canonical = await realpath(resolved).catch(() => null);
			if (!canonical && !path.isAbsolute(requested)) {
				canonical = await realpath(path.resolve(process.cwd(), requested)).catch(() => null);
			}
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
			if (ws.data.kind === "relay") {
				relay.handleOpen(ws);
				return;
			}
			sockets.add(ws);
			startDaemonPoll();
			// Auto-attach to the most-recently-created live session: a bare WS
			// open reproduces the single-session priming sequence unchanged.
			const entry = lastHandle ? sessions.get(lastHandle) : undefined;
			if (entry) attachSocket(ws, entry);
		},
		close(ws) {
			if (ws.data.kind === "relay") {
				relay.handleClose(ws);
				return;
			}
			// Detach only: sessions outlive sockets.
			sockets.delete(ws);
			if (sockets.size === 0) stopDaemonPoll();
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
			if (ws.data.kind === "relay") {
				relay.handleMessage(ws, raw);
				return;
			}
			void handleCommand(ws, raw);
		},
	},
});

/** Collab relay base URL: env-overridable, defaults to this server's own port. */
function relayBaseUrl(): string {
	return Bun.env.OMP_WEB_COLLAB_URL ?? `ws://localhost:${server.port}`;
}

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
		// Collab teardown first: stop the adapter and destroy its relay room.
		const adapter = entry.collab.adapter;
		const roomId = adapter?.status?.roomId;
		entry.collab.adapter = null;
		if (adapter) await adapter.stop("server shutting down").catch(() => {});
		if (roomId) relay.closeRoom(roomId);
		entry.session.beginDispose();
		await entry.session.dispose().catch(() => {});
	}
	sessions.clear();
	server.stop();
	process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
