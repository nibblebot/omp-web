import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ClientCommand, ImageArg, LiveSessionEntry, ProcessStats, ModelInfo, AvailableSlashCommand, WebMethodName, WebSessionState, ServerFrame, SessionListEntry } from "./protocol";

export type Block = { kind: "text" | "thinking"; text: string };
export type ToolStatus = "running" | "done" | "error";
export type BashItem = {
	kind: "bash";
	id: number;
	command: string;
	dimmed: boolean;
	status: "running" | "done";
	output: string;
	exitCode: number | null;
	truncated: boolean;
};
export type CompactionItem = {
	kind: "compaction";
	id: number;
	action: string;
	summary?: string;
	tokensBefore?: number;
	skipped: boolean;
	aborted: boolean;
	willRetry: boolean;
	errorMessage?: string;
};
export type ChatItem =
	| { kind: "user"; id: number; text: string }
	| { kind: "assistant"; id: number; blocks: Block[] }
	| { kind: "tool"; id: number; toolCallId: string; name: string; args: unknown; status: ToolStatus; output: string }
	| BashItem
	| CompactionItem
	| { kind: "notice"; id: number; level: string; message: string; href?: string };

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** Tracked subagent, maintained from subagent_lifecycle/subagent_progress frames. */
export interface SubagentInfo {
	id: string;
	index: number;
	agent: string;
	description?: string;
	task?: string;
	status: string;
	lastUpdate: number;
}

/** Names of the modals the store can summon; components render on match. */
export type ModalName =
	| "help"
	| "model"
	| "thinking"
	| "stats"
	| "settings"
	| "sessions"
	| "branch"
	| "history"
	| "subagents"
	| "login";

/** Derived one-line args summary for the generic tool card (raw args stay structured). */
export function argsSummary(args: unknown): string {
	let s: string;
	try {
		s = JSON.stringify(args ?? null) ?? "";
	} catch {
		s = String(args);
	}
	s = tabsToSpaces(s);
	return s.length > 500 ? s.slice(0, 500) : s;
}

/** localStorage key for the sessions sidebar visibility toggle. */
const SIDEBAR_KEY = "omp.sidebarVisible";

export const [state, setState] = createStore({
	items: [] as ChatItem[],
	live: { active: false, blocks: [] as Block[] },
	// --- WebSessionState mirror (verbatim; see protocol state frames) ---
	streaming: false,
	compacting: false,
	model: undefined as WebSessionState["model"],
	thinkingLevel: undefined as WebSessionState["thinkingLevel"],
	sessionName: undefined as string | undefined,
	sessionId: "",
	// Phase 2: server-assigned handle of the live session this tab is attached
	// to (distinct from sessionId above, the agent's own id, which changes on
	// switchSession). Session-scoped frames for any other handle are dropped.
	currentSessionId: "",
	sessionFile: undefined as string | undefined,
	contextUsage: undefined as WebSessionState["contextUsage"],
	queuedMessageCount: 0,
	messageCount: 0,
	todoPhases: [] as WebSessionState["todoPhases"],
	steeringMode: "all" as WebSessionState["steeringMode"],
	followUpMode: "all" as WebSessionState["followUpMode"],
	interruptMode: "immediate" as WebSessionState["interruptMode"],
	autoCompactionEnabled: true,
	autoRetryEnabled: true,
	dumpTools: [] as NonNullable<WebSessionState["dumpTools"]>,
	// --- Server-pushed extras ---
	availableCommands: [] as AvailableSlashCommand[],
	availableModels: [] as ModelInfo[],
	stats: null as SessionStats | null,
	goal: null as { objective: string } | null,
	subagents: new Map<string, SubagentInfo>(),
	connected: false,
	modal: null as ModalName | null,
	toolsExpanded: false,
	// Sessions sidebar: polled live-session roster + server process stats.
	liveSessions: [] as LiveSessionEntry[],
	processStats: null as ProcessStats | null,
	sidebarVisible: typeof localStorage !== "undefined" ? localStorage.getItem(SIDEBAR_KEY) !== "false" : true,
	// Phase 6: in-flight OAuth login prompts (unicast frames).
	loginUrl: null as { url: string; launchUrl?: string; instructions?: string } | null,
	loginCodeRequest: null as { requestId: string; title: string; placeholder?: string } | null,
	// Phase 3: pending server-pushed ExtensionUIContext dialog (ui_request
	// frame); answered via sendUiResponse/cancelUiRequest.
	uiRequest: null as { id: string; method: string; params: unknown } | null,
	// Display toggles (StatusBar checkboxes); both default off = raw streaming.
	reveal: false,
	soften: false,
	error: null as string | null,
});

let nextId = 1;

function tabsToSpaces(s: string): string {
	return s.replace(/\t/g, "  ");
}

function capTail(s: string, max: number): string {
	return s.length > max ? s.slice(-max) : s;
}

function extractText(value: unknown): string {
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		const parts: string[] = [];
		for (const c of value.content) {
			if (c && typeof c === "object" && "type" in c && c.type === "text" && "text" in c && typeof c.text === "string") {
				parts.push(c.text);
			}
		}
		return parts.join("\n");
	}
	if (value == null) return "";
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return String(value);
	}
}

type UserContent = Extract<AgentMessage, { role: "user" }>["content"];
type AssistantContent = Extract<AgentMessage, { role: "assistant" }>["content"];

function userText(content: UserContent): string {
	if (typeof content === "string") return tabsToSpaces(content);
	return tabsToSpaces(content.map(c => (c.type === "text" ? c.text : "[image]")).join("\n"));
}

function pushItem(item: ChatItem): void {
	setState("items", items => [...items, item]);
}

export function pushNotice(level: string, message: string, href?: string): void {
	pushItem({ kind: "notice", id: nextId++, level, message, href });
}

export function pushCompaction(item: Omit<CompactionItem, "kind" | "id">): void {
	pushItem({ kind: "compaction", id: nextId++, ...item });
}

/** Bang-shell item: appears immediately as a spinner, resolved by the bash call. */
export function addBashItem(command: string, dimmed: boolean): number {
	const id = nextId++;
	pushItem({ kind: "bash", id, command, dimmed, status: "running", output: "", exitCode: null, truncated: false });
	return id;
}

export interface BashResultLike {
	output: string;
	exitCode: number;
	cancelled?: boolean;
	timedOut?: boolean;
	truncated?: boolean;
}

export function resolveBashItem(id: number, result: BashResultLike | { error: string }): void {
	const index = state.items.findIndex(it => it.kind === "bash" && it.id === id);
	if (index < 0) return;
	setState(
		"items",
		produce(items => {
			const item = items[index];
			if (item?.kind !== "bash") return;
			item.status = "done";
			if ("error" in result) {
				item.output = result.error;
				item.exitCode = null;
			} else {
				item.output = capTail(result.output, 8000);
				item.exitCode = result.exitCode;
				item.truncated = result.truncated ?? false;
			}
		}),
	);
}

function findToolIndex(toolCallId: string): number {
	return state.items.findIndex(it => it.kind === "tool" && it.toolCallId === toolCallId);
}

// Token deltas are buffered and applied at most once per animation frame,
// capping store writes at ≤60/s regardless of provider chunk rate.
const pendingDeltas = new Map<number, { kind: Block["kind"]; text: string }>();
let rafId = 0;

// Reveal queue: instead of applying each frame's full backlog, drain at a
// chars/sec rate that eases with backlog size, so bursts appear smoothly.
// Each arrival sets a deadline; the drain rate is backlog/time-left, so the
// display is never more than REVEAL_MAX_LAG_SEC behind the last delta.
const REVEAL_BASE_CHARS_PER_SEC = 180;
const REVEAL_MAX_LAG_SEC = 0.4;
let lastFlushTime = 0;
let drainDeadline = 0;

// Length (in UTF-16 units) of the first `n` code points of `s`, so a
// surrogate pair is never split across a drain boundary.
function codePointCut(s: string, n: number): number {
	let i = 0;
	while (n-- > 0 && i < s.length) {
		const c = s.charCodeAt(i);
		i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
	}
	return i;
}

function scheduleFlush(): void {
	if (rafId !== 0) return;
	rafId = requestAnimationFrame(flushDeltas);
}

function flushDeltas(): void {
	rafId = 0;
	if (pendingDeltas.size === 0) return;
	// Use the same clock as drainDeadline — rAF callback timestamps are not
	// guaranteed to be comparable (headless BeginFrame can schedule them ahead).
	const now = performance.now();
	let budget = Number.POSITIVE_INFINITY;
	if (state.reveal) {
		const dt = Math.min(Math.max((now - lastFlushTime) / 1000, 0), 0.1) || 1 / 60;
		let backlog = 0;
		for (const d of pendingDeltas.values()) backlog += d.text.length;
		const timeLeft = Math.max(drainDeadline - now, dt * 1000);
		const rate = Math.max(REVEAL_BASE_CHARS_PER_SEC, backlog / (timeLeft / 1000));
		budget = Math.max(1, Math.round(rate * dt));
	}
	lastFlushTime = now;
	for (const [index, d] of pendingDeltas) {
		if (budget <= 0) break;
		const cut = budget >= d.text.length ? d.text.length : codePointCut(d.text, budget);
		if (state.live.blocks[index]?.kind !== d.kind) ensureLiveBlock(index, d.kind);
		// In-place path mutation keeps block identity stable, so <For> does not
		// recreate LiveBlock components on every frame.
		setState("live", "blocks", index, "text", text => text + tabsToSpaces(d.text.slice(0, cut)));
		if (cut >= d.text.length) pendingDeltas.delete(index);
		else d.text = d.text.slice(cut);
		budget -= cut;
	}
	if (pendingDeltas.size > 0) scheduleFlush();
}

function ensureLiveBlock(contentIndex: number, kind: Block["kind"]): void {
	setState("live", "blocks", blocks => {
		if (blocks[contentIndex]?.kind === kind) return blocks;
		const next = blocks.slice();
		next[contentIndex] = { kind, text: next[contentIndex]?.text ?? "" };
		return next;
	});
}

function assistantBlocks(content: AssistantContent): Block[] {
	const blocks: Block[] = [];
	for (const c of content) {
		if (c.type === "text") blocks.push({ kind: "text", text: tabsToSpaces(c.text) });
		else if (c.type === "thinking") blocks.push({ kind: "thinking", text: tabsToSpaces(c.thinking) });
	}
	return blocks;
}

export function applyEvent(e: AgentSessionEvent): void {
	switch (e.type) {
		case "agent_start":
			setState("streaming", true);
			break;
		case "agent_end":
			// The final message content is authoritative (message_end pushes the
			// full item); leftover queue entries must not leak into the next message.
			pendingDeltas.clear();
			setState("streaming", false);
			setState("live", "active", false);
			break;
		case "message_start": {
			const msg = e.message;
			if (msg.role === "user") {
				pushItem({ kind: "user", id: nextId++, text: userText(msg.content) });
			} else if (msg.role === "assistant") {
				setState("live", { active: true, blocks: [] });
			}
			break;
		}
		case "message_update": {
			if (e.message.role !== "assistant") break;
			const ev = e.assistantMessageEvent;
			switch (ev.type) {
				case "text_start":
					ensureLiveBlock(ev.contentIndex, "text");
					break;
				case "thinking_start":
					ensureLiveBlock(ev.contentIndex, "thinking");
					break;
				case "text_delta":
				case "thinking_delta": {
					const kind = ev.type === "text_delta" ? "text" : "thinking";
					const pending = pendingDeltas.get(ev.contentIndex);
					if (pending) pending.text += ev.delta;
					else pendingDeltas.set(ev.contentIndex, { kind, text: ev.delta });
					// The drain deadline belongs to arrivals only; reschedules from
					// flushDeltas must not extend it or the drain never completes.
					drainDeadline = performance.now() + REVEAL_MAX_LAG_SEC * 1000;
					scheduleFlush();
					break;
				}
				default:
					// toolcall_*/done/error: full args arrive on tool_execution_start;
					// commit happens on message_end.
					break;
			}
			break;
		}
		case "message_end": {
			const msg = e.message;
			if (msg.role === "assistant") {
				pendingDeltas.clear();
				pushItem({ kind: "assistant", id: nextId++, blocks: assistantBlocks(msg.content) });
				setState("live", "active", false);
			}
			break;
		}
		case "tool_execution_start":
			pushItem({
				kind: "tool",
				id: nextId++,
				toolCallId: e.toolCallId,
				name: e.toolName,
				args: e.args ?? null,
				status: "running",
				output: "",
			});
			break;
		case "tool_execution_update": {
			const index = findToolIndex(e.toolCallId);
			if (index >= 0)
				setState(
					"items",
					produce(items => {
						const item = items[index];
						if (item?.kind === "tool") item.output = capTail(tabsToSpaces(extractText(e.partialResult)), 8000);
					}),
				);
			break;
		}
		case "tool_execution_end": {
			const index = findToolIndex(e.toolCallId);
			if (index >= 0)
				setState(
					"items",
					produce(items => {
						const item = items[index];
						if (item?.kind === "tool") {
							item.status = e.isError ? "error" : "done";
							item.output = capTail(tabsToSpaces(extractText(e.result)), 8000);
						}
					}),
				);
			break;
		}
		case "notice":
			pushItem({ kind: "notice", id: nextId++, level: e.level, message: e.message });
			break;
		case "thinking_level_changed":
			setState("thinkingLevel", e.thinkingLevel ?? undefined);
			break;
		case "goal_updated":
			setState("goal", e.goal ? { objective: e.goal.objective } : null);
			break;
		case "auto_retry_start":
			pushItem({
				kind: "notice",
				id: nextId++,
				level: "warning",
				message: `Retrying (attempt ${e.attempt}/${e.maxAttempts}): ${e.errorMessage}`,
			});
			break;
		case "auto_compaction_start":
			pushItem({ kind: "notice", id: nextId++, level: "info", message: "Compacting context…" });
			break;
		case "auto_compaction_end": {
			pushCompaction({
				action: e.action,
				summary: e.result?.summary,
				tokensBefore: e.result?.tokensBefore,
				skipped: e.skipped ?? false,
				aborted: e.aborted,
				willRetry: e.willRetry,
				errorMessage: e.errorMessage,
			});
			break;
		}
		case "auto_retry_end":
			pushItem({
				kind: "notice",
				id: nextId++,
				level: e.success ? "info" : "error",
				message: e.success
					? `Retry ${e.attempt} succeeded`
					: `Retry ${e.attempt} failed: ${e.finalError ?? "unknown error"}`,
			});
			break;
		case "retry_fallback_applied":
			pushItem({
				kind: "notice",
				id: nextId++,
				level: "warning",
				message: `Model fallback: ${e.from} → ${e.to}`,
			});
			break;
		case "retry_fallback_succeeded":
			pushItem({
				kind: "notice",
				id: nextId++,
				level: "info",
				message: `Fallback model ${e.model} succeeded`,
			});
			break;
		default:
			// turn_start/turn_end, ttsr_triggered, todo_*, irc_message: ignored.
			break;
	}
}

export function loadHistory(messages: AgentMessage[]): void {
	pendingDeltas.clear();
	// Phase 5: reset id sequence so newly-switched sessions don't collide with
	// leftover ids from the prior transcript.
	nextId = 1;
	setState({ items: [], live: { active: false, blocks: [] } });
	for (const msg of messages) {
		if (msg.role === "user") {
			pushItem({ kind: "user", id: nextId++, text: userText(msg.content) });
		} else if (msg.role === "assistant") {
			pushItem({ kind: "assistant", id: nextId++, blocks: assistantBlocks(msg.content) });
			for (const c of msg.content) {
				if (c.type === "toolCall") {
					pushItem({
						kind: "tool",
						id: nextId++,
						toolCallId: c.id,
						name: c.name,
						args: c.arguments ?? {},
						status: "done",
						output: "",
					});
				}
			}
		} else if (msg.role === "toolResult") {
			const index = findToolIndex(msg.toolCallId);
			const output = capTail(tabsToSpaces(extractText(msg)), 8000);
			const status: ToolStatus = msg.isError ? "error" : "done";
			if (index >= 0) {
				setState(
					"items",
					produce(items => {
						const item = items[index];
						if (item?.kind === "tool") {
							item.output = output;
							item.status = status;
						}
					}),
				);
			} else {
				pushItem({ kind: "tool", id: nextId++, toolCallId: msg.toolCallId, name: msg.toolName, args: null, status, output });
			}
		}
		// Any other role (developer, custom messages): skip.
	}
}

function applyState(s: WebSessionState, stats?: SessionStats): void {
	setState({
		model: s.model,
		thinkingLevel: s.thinkingLevel,
		streaming: s.isStreaming,
		compacting: s.isCompacting,
		steeringMode: s.steeringMode,
		followUpMode: s.followUpMode,
		interruptMode: s.interruptMode,
		sessionFile: s.sessionFile,
		sessionId: s.sessionId,
		sessionName: s.sessionName,
		autoCompactionEnabled: s.autoCompactionEnabled,
		autoRetryEnabled: s.autoRetryEnabled,
		messageCount: s.messageCount,
		queuedMessageCount: s.queuedMessageCount,
		todoPhases: s.todoPhases,
		contextUsage: s.contextUsage,
		dumpTools: s.dumpTools ?? [],
		...(stats !== undefined ? { stats } : {}),
	});
}

let ws: WebSocket | null = null;

// Dev-only inspection handle (tests drive the UI through it).
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__ompState = state;

// ---------------------------------------------------------------------------
// call() relay: id-keyed promise map resolved by matching call_result frames.
// ---------------------------------------------------------------------------
let nextCallId = 1;
const pendingCalls = new Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: number }>();

function rejectPendingCalls(err: Error): void {
	for (const [id, p] of pendingCalls) {
		clearTimeout(p.timer);
		p.reject(err);
		pendingCalls.delete(id);
	}
}

export function call(method: WebMethodName, args: unknown[] = [], timeoutMs = 30_000): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		reject(new Error("Not connected"));
		return promise;
	}
	const id = `c${nextCallId++}`;
	// OAuth/manual-code flows exceed any sane default; login passes 0.
	const timer =
		timeoutMs > 0
			? window.setTimeout(() => {
					pendingCalls.delete(id);
					reject(new Error(`call "${method}" timed out`));
				}, timeoutMs)
			: 0;
	pendingCalls.set(id, { resolve, reject, timer });
	ws.send(JSON.stringify({ type: "call", id, method, args } satisfies ClientCommand));
	return promise;
}

/** Payload delivered into the PromptBox textarea (and image tray) by QueueBar/HistorySearch. */
export interface PromptInsert {
	text: string;
	images?: ImageArg[];
}

/**
 * Cross-component prompt insertion inbox: QueueBar dequeue and HistorySearch
 * picks publish here; PromptBox consumes and clears (it owns the textarea).
 */
export const [promptInsert, setPromptInsert] = createSignal<PromptInsert | null>(null);

/** Phase 7: pop the last queued message back into the prompt (QueueBar ×, Alt+↑). */
export function dequeueLastQueued(): void {
	void call("popLastQueuedMessage")
		.then(restored => {
			const msg = restored as { text: string; images?: ImageArg[] } | undefined;
			if (msg) setPromptInsert({ text: msg.text, images: msg.images });
		})
		.catch(err => setState("error", String(err)));
}

// list_sessions / list_files carry no id on the wire; with a single user,
// latest-wins correlation is sufficient (a superseded request resolves empty.
let pendingSessions: ((sessions: SessionListEntry[]) => void) | null = null;
let pendingFiles: ((files: string[]) => void) | null = null;

export function listSessions(): Promise<SessionListEntry[]> {
	const { promise, resolve, reject } = Promise.withResolvers<SessionListEntry[]>();
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingSessions?.([]);
	pendingSessions = resolve;
	ws.send(JSON.stringify({ type: "list_sessions" } satisfies ClientCommand));
	return promise;
}

export function listFiles(query: string, limit?: number): Promise<string[]> {
	const { promise, resolve, reject } = Promise.withResolvers<string[]>();
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingFiles?.([]);
	pendingFiles = resolve;
	ws.send(JSON.stringify({ type: "list_files", query, limit } satisfies ClientCommand));
	return promise;
}

export function sendLoginCode(requestId: string, code: string): void {
	setState("loginCodeRequest", null);
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "login_code", requestId, code } satisfies ClientCommand));
	}
}

// Phase 3: answer the server's ui_request (ExtensionUIContext dialogs).
// Routing is by socket attachment — no sessionId on the command.
export function sendUiResponse(id: string, result: unknown): void {
	if (state.uiRequest?.id === id) setState("uiRequest", null);
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "ui_response", id, result } satisfies ClientCommand));
	}
}

// Cancellation resolves the request undefined — NOT the error variant. The
// AskTool rich-dialog path (tools/ask.ts) maps an undefined result to
// ToolAbortError("Ask tool was cancelled by the user"); a rejected promise
// (`error` field) would surface the raw error text instead.
export function cancelUiRequest(id: string): void {
	if (state.uiRequest?.id === id) setState("uiRequest", null);
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "ui_response", id } satisfies ClientCommand));
	}
}

/** Steer a running subagent mid-task; rejects for unknown/idle/parked agents. */
export function steerSubagent(agentId: string, text: string): Promise<unknown> {
	return call("subagentSteer", [agentId, text]);
}

/** Abort one running subagent; Main and siblings are unaffected. */
export function abortSubagent(agentId: string): Promise<unknown> {
	return call("subagentAbort", [agentId]);
}

// ---------------------------------------------------------------------------
// Phase 2 multiplexing. create_session/attach are acknowledged by the
// server's unicast `attached` frame (latest-wins, like listSessions);
// close_session is fire-and-forget — the server detaches affected sockets.
// ---------------------------------------------------------------------------
/** Answer to list_live_sessions: roster plus server process stats. */
export type LiveSessionsResult = { sessions: LiveSessionEntry[]; process: ProcessStats | null };

let pendingAttach: { resolve: (sessionId: string) => void; reject: (err: Error) => void } | null = null;
let pendingLive: ((result: LiveSessionsResult) => void) | null = null;

function requestAttach(cmd: ClientCommand): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		reject(new Error("Not connected"));
		return promise;
	}
	// Latest-wins: a superseded attach resolves to whatever session is current.
	pendingAttach?.resolve(state.currentSessionId);
	pendingAttach = { resolve, reject };
	ws.send(JSON.stringify(cmd));
	return promise;
}

/** Create a new live session and attach this tab to it; resolves with its handle. */
export function createSession(cwd?: string): Promise<string> {
	return requestAttach({ type: "create_session", cwd });
}

/** Attach this tab to an existing live session; resolves with the handle. */
export function attachSession(sessionId: string): Promise<string> {
	return requestAttach({ type: "attach", sessionId });
}

/** Dispose a live session server-side; tabs attached to it are detached there. */
export function closeSession(sessionId: string): void {
	if (ws?.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type: "close_session", sessionId } satisfies ClientCommand));
	}
}

export function listLiveSessions(): Promise<LiveSessionsResult> {
	const { promise, resolve, reject } = Promise.withResolvers<LiveSessionsResult>();
	if (!ws || ws.readyState !== WebSocket.OPEN) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingLive?.({ sessions: [], process: null });
	pendingLive = resolve;
	ws.send(JSON.stringify({ type: "list_live_sessions" } satisfies ClientCommand));
	return promise;
}

// ---------------------------------------------------------------------------
// Sessions sidebar poll: refresh the roster every 5s, but only while the
// sidebar is visible and the socket is connected (started from onopen,
// stopped from onclose/setSidebarVisible; restart on reconnect/re-show).
// ---------------------------------------------------------------------------
let sidebarPoll: number | undefined;

function refreshLiveSessions(): void {
	void listLiveSessions()
		.then(({ sessions, process }) => {
			setState("liveSessions", sessions);
			setState("processStats", process);
		})
		.catch(() => {});
}

function startSidebarPoll(): void {
	stopSidebarPoll();
	refreshLiveSessions(); // immediate refresh — no 5s initial gap
	sidebarPoll = window.setInterval(refreshLiveSessions, 5000);
}

function stopSidebarPoll(): void {
	if (sidebarPoll !== undefined) {
		clearInterval(sidebarPoll);
		sidebarPoll = undefined;
	}
}

export function setSidebarVisible(visible: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(SIDEBAR_KEY, String(visible));
	setState("sidebarVisible", visible);
	if (visible && state.connected) startSidebarPoll();
	else stopSidebarPoll();
}

export function toggleSidebar(): void {
	setSidebarVisible(!state.sidebarVisible);
}

/** Per-session UI state dropped when attaching to a different session. */
function resetSessionView(): void {
	pendingDeltas.clear();
	// Same rationale as loadHistory: ids must not collide across transcripts.
	nextId = 1;
	setState({
		items: [],
		live: { active: false, blocks: [] },
		subagents: new Map<string, SubagentInfo>(),
		stats: null,
		goal: null,
		modal: null,
		loginUrl: null,
		loginCodeRequest: null,
		uiRequest: null,
	});
}

let backoff = 1000;

export function connect(): void {
	const socket = new WebSocket(`ws://${location.host}/ws`);
	ws = socket;
	socket.onopen = () => {
		backoff = 1000;
		setState("connected", true);
		if (state.sidebarVisible) startSidebarPoll();
		void call("getSubagents")
			.then(subs => {
				const next = new Map<string, SubagentInfo>();
				for (const s of subs as SubagentInfo[]) if (s.id) next.set(s.id, s);
				setState("subagents", next);
			})
			.catch(() => {});
	};
	socket.onmessage = ev => {
		const frame = JSON.parse(String(ev.data)) as ServerFrame;
		if (frame.type === "attached") {
			const switched = state.currentSessionId !== "" && state.currentSessionId !== frame.sessionId;
			setState("currentSessionId", frame.sessionId);
			pendingAttach?.resolve(frame.sessionId);
			pendingAttach = null;
			// Roster changed (create/attach/close): refresh immediately instead of
			// waiting for the next 5s poll tick.
			refreshLiveSessions();
			if (switched) {
				// In-flight calls belonged to the previous session; their results
				// are stale now and would be filtered out below.
				rejectPendingCalls(new Error("session switched"));
				resetSessionView();
				// Roster is event-driven; pull the attached session's once.
				void call("getSubagents")
					.then(subs => {
						const next = new Map<string, SubagentInfo>();
						for (const s of subs as SubagentInfo[]) if (s.id) next.set(s.id, s);
						setState("subagents", next);
					})
					.catch(() => {});
			}
			return;
		}
		// Stale-frame guard: session-scoped frames for a handle this tab no
		// longer views (in flight during a switch) are dropped.
		if ("sessionId" in frame && frame.sessionId !== state.currentSessionId) return;
		switch (frame.type) {
			case "history":
				loadHistory(frame.messages);
				break;
			case "state":
				applyState(frame.state, frame.stats);
				break;
			case "event":
				applyEvent(frame.event);
				break;
			case "call_result": {
				const pending = pendingCalls.get(frame.id);
				if (!pending) break; // unknown id (timed out or stale): ignore
				pendingCalls.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.ok) pending.resolve(frame.data);
				else pending.reject(new Error(frame.error ?? "call failed"));
				break;
			}
			case "available_commands":
				setState("availableCommands", frame.commands);
				break;
			case "sessions":
				pendingSessions?.(frame.sessions);
				pendingSessions = null;
				break;
			case "live_sessions":
				pendingLive?.({ sessions: frame.sessions, process: frame.process });
				pendingLive = null;
				break;
			case "files":
				pendingFiles?.(frame.files);
				pendingFiles = null;
				break;
			case "subagent_lifecycle": {
				const p = frame.payload as Partial<SubagentInfo> | undefined;
				if (!p?.id) break;
				setState("subagents", prev => {
					const next = new Map(prev);
					const existing = next.get(p.id as string);
					next.set(p.id as string, {
						id: p.id as string,
						index: p.index ?? existing?.index ?? -1,
						agent: p.agent ?? existing?.agent ?? "agent",
						description: p.description ?? existing?.description,
						task: existing?.task,
						status: p.status ?? "started",
						lastUpdate: Date.now(),
					});
					return next;
				});
				break;
			}
			case "subagent_progress": {
				const p = frame.payload as { index?: number; agent?: string; task?: string; progress?: { status?: string } } | undefined;
				if (p?.index === undefined) break;
				setState("subagents", prev => {
					const next = new Map(prev);
					let key = [...next.keys()].find(k => next.get(k)?.index === p.index);
					if (!key) {
						key = `progress-${p.index}`;
						next.set(key, {
							id: key,
							index: p.index as number,
							agent: p.agent ?? "agent",
							status: "started",
							lastUpdate: Date.now(),
						});
					}
					const entry = next.get(key);
					if (entry) {
						if (p.task !== undefined) entry.task = p.task;
						if (p.progress?.status) entry.status = p.progress.status;
						entry.lastUpdate = Date.now();
					}
					return next;
				});
				break;
			}
			case "subagent_event":
				// Raw subagent session events: not subscribed ("progress" level only).
				break;
			case "login_url":
				// No window.open here: async WS frames lack user activation and the
				// popup would be blocked. LoginPanel owns the tab handoff.
				setState("loginUrl", { url: frame.url, launchUrl: frame.launchUrl, instructions: frame.instructions });
				break;
			case "login_code_request":
				setState("loginCodeRequest", { requestId: frame.requestId, title: frame.title, placeholder: frame.placeholder });
				break;
			case "ui_request":
				// Replace-with-warning: a second dialog supersedes the open one.
				// Answer the stale id as cancelled so its server-side pending
				// promise settles instead of hanging until socket close.
				if (state.uiRequest) {
					console.warn(`ui_request ${frame.id} superseding unanswered ${state.uiRequest.id}`);
					cancelUiRequest(state.uiRequest.id);
				}
				setState("uiRequest", { id: frame.id, method: frame.method, params: frame.params });
				break;
			case "error":
				setState("error", frame.error);
				// create_session/attach failures surface as a (global) error
				// frame rather than `attached`; settle the waiter instead of
				// leaving it hanging.
				pendingAttach?.reject(new Error(frame.error));
				pendingAttach = null;
				break;
		}
	};
	socket.onclose = () => {
		setState("connected", false);
		stopSidebarPoll();
		if (ws !== socket) return;
		rejectPendingCalls(new Error("Disconnected"));
		pendingSessions?.([]);
		pendingSessions = null;
		pendingFiles?.([]);
		pendingFiles = null;
		pendingAttach?.reject(new Error("Disconnected"));
		pendingAttach = null;
		pendingLive?.({ sessions: [], process: null });
		pendingLive = null;
		const delay = backoff;
		backoff = Math.min(backoff * 2, 8000);
		setTimeout(connect, delay);
	};
}
