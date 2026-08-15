import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionStats } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { OMP_PROTO, SSE_EVENT_NAME, SSE_SILENCE_DEADLINE_MS, daemonsKey } from "../shared/protocol";
import type { ClientCommand, DaemonEntry, DaemonInfo, ImageArg, ModelInfo, AvailableSlashCommand, ProjectEntry, WebMethodName, WebSessionState, ServerFrame, SessionListEntry, SettingsModel } from "../shared/protocol";
import { SSE_PING_EVENT } from "../shared/sse";
import { scanImages } from "./images";
import type { UsageLike } from "./usage";

export type Block = { kind: "text" | "thinking"; text: string };
export type ToolStatus = "running" | "done" | "error";
export type ToolCardsView = "expanded" | "collapsed" | "consolidated";
export type BashItem = {
	kind: "bash";
	id: number;
	command: string;
	dimmed: boolean;
	/** "python" for $/$$ items; the same card/streaming path as bang-shell. */
	lang: "bash" | "python";
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
	| { kind: "user"; id: number; text: string; images?: ImageArg[] }
	| { kind: "assistant"; id: number; blocks: Block[]; usage?: UsageLike; ttft?: number; duration?: number }
	| { kind: "tool"; id: number; toolCallId: string; name: string; args: unknown; status: ToolStatus; output: string; images?: ImageArg[] }
	| BashItem
	| CompactionItem
	| { kind: "notice"; id: number; level: string; message: string; href?: string };

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export type DebugLevel = "info" | "warn" | "error";

/** One client-side transport lifecycle event for the Debug panel. */
export interface DebugEntry {
	ts: number;
	level: DebugLevel;
	source: "transport" | "command" | "roster";
	message: string;
}

/** Tracked subagent, maintained from subagent_lifecycle/subagent_progress frames. */
export interface SubagentInfo {
	id: string;
	index: number;
	agent: string;
	description?: string;
	task?: string;
	status: string;
	lastUpdate: number;
	/** toolCallId of the task call that spawned this subagent (SDK payload field). */
	parentToolCallId?: string;
}

const ACTIVE_SUBAGENT_STATUSES = new Set(["pending", "started", "running"]);

/** True while the subagent is in flight; terminal statuses collapse the strip. */
export function isActiveSubagent(sub: SubagentInfo): boolean {
	return ACTIVE_SUBAGENT_STATUSES.has(sub.status);
}

const LIVE_DAEMON_STATES = new Set(["starting", "running", "ready", "restarting", "stopping"]);

/** Daemon still supervised (not exited/failed); drives the processes strip's visibility. */
export function isLiveDaemon(d: DaemonInfo): boolean {
	return LIVE_DAEMON_STATES.has(d.state);
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
	| "login"
	| "goal"
	| "usage"
	| "debug";

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

/** localStorage key for the roster sidebar visibility toggle. */
const SIDEBAR_KEY = "omp.sidebarVisible";

/** localStorage key for the pet roster visibility toggle. */
const PET_KEY = "omp.petVisible";

/** localStorage key for the Phase 11 desktop-notifications toggle. */
const NOTIFY_KEY = "omp.notifyEnabled";

export const [state, setState] = createStore({
	items: [] as ChatItem[],
	live: { active: false, blocks: [] as Block[] },
	// --- WebSessionState mirror (verbatim; see protocol state frames) ---
	streaming: false,
	compacting: false,
	model: undefined as WebSessionState["model"],
	modelRoles: undefined as WebSessionState["modelRoles"],
	modelRoleCatalog: undefined as WebSessionState["modelRoleCatalog"],
	modelRoleStorage: undefined as WebSessionState["modelRoleStorage"],
	thinkingLevel: undefined as WebSessionState["thinkingLevel"],
	sessionName: undefined as string | undefined,
	sessionId: "",
	// R8 omp-session readiness: set by the `ready` broadcast (or a stamped state
	// frame) once the SDK session is live and provider/model/auth resolved.
	readyAt: undefined as WebSessionState["readyAt"],
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
	// --- Phase 9: modes & usage parity (WebSessionState mirror) ---
	goalModeState: undefined as WebSessionState["goalModeState"],
	planModeEnabled: false,
	fastModeEnabled: false,
	computerToolEnabled: false,
	inspectImageMode: "auto" as WebSessionState["inspectImageMode"],
	// Live auto-retry countdown (auto_retry_start/auto_retry_end events).
	retryInfo: null as { attempt: number; maxAttempts: number; delayMs: number; until: number } | null,
	// --- Server-pushed extras ---
	availableCommands: [] as AvailableSlashCommand[],
	availableModels: [] as ModelInfo[],
	stats: null as SessionStats | null,
	goal: null as { objective: string } | null,
	subagents: new Map<string, SubagentInfo>(),
	connected: false,
	modal: null as ModalName | null,
	toolsExpanded: false,
	toolCardsView: "expanded" as ToolCardsView,
	// Daemon broker roster (hub/launch long-running processes); project-scoped,
	// so resetSessionView must NOT clear it.
	daemons: new Map<string, DaemonInfo>(),
	// Settings model (getSettings/setSetting + settings_changed frames).
	settingsModel: null as SettingsModel | null,
	settingsLoading: false,
	// Attach mode: "single" (standalone omp-session — no sidebar) or "roster"
	// (fleet edge — the fleet roster sidebar). "roster" is set by the roster
	// frame and sticky across reconnects; the attached frame carries no mode
	// field and must not clobber it (Phase 6 de-mux).
	sessionMode: "single" as "single" | "roster",
	// Fleet edge roster (roster frame). Patched in place by
	// daemon_status frames; NOT cleared by resetSessionView (it is
	// fleet-scoped, not session-scoped).
	daemonRoster: [] as DaemonEntry[],
	sidebarVisible: typeof localStorage !== "undefined" ? localStorage.getItem(SIDEBAR_KEY) !== "false" : true,
	petVisible: typeof localStorage !== "undefined" ? localStorage.getItem(PET_KEY) !== "false" : true,
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
	// Client-side debug ring (Debug panel): one entry per transport lifecycle
	// event, capped at DEBUG_RING_CAP (oldest dropped). Mirror of the fleet's
	// /ctl/debug log for the browser half of the connection loop.
	debugLog: [] as DebugEntry[],
	// Last /events downlink activity (frame or ping) in ms epoch; 0 = never.
	// Drives the panel's "seconds since last frame" readout.
	lastFrameAt: 0,
	// Delay (ms) of the next scheduled manual reconnect; 0 = stream open (no
	// retry pending). Mirrors the module-level backoff ladder for the panel.
	reconnectDelay: 0,
	// Phase 11: desktop notifications on turn completion while hidden
	// (persisted toggle; firing is gated on Notification support + permission).
	notifyEnabled:
		typeof localStorage !== "undefined" && typeof Notification !== "undefined"
			? localStorage.getItem(NOTIFY_KEY) === "true"
			: false,
	// Phase 11: /btw side-panel session. streamId routes ephemeral_delta
	// frames to this panel; the panel never appears in the transcript.
	btw: null as null | { question: string; reply: string; streaming: boolean; streamId: number; error?: string },
});

/** R8 omp-session readiness accessor: true once the boot session's gate has cleared
 *  (the server broadcast `ready` or stamped readyAt into a state frame). */
export function isReady(): boolean {
	return state.readyAt !== undefined;
}

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

/**
 * First ~max code points of a string, never splitting a surrogate pair —
 * the desktop-notification body is capped so the OS banner stays readable.
 */
export function truncateHead(s: string, max = 80): string {
	if (s.length <= max) return s;
	let i = 0;
	while (i < max && i < s.length) {
		const c = s.charCodeAt(i);
		i += c >= 0xd800 && c <= 0xdbff ? 2 : 1;
	}
	return s.slice(0, i);
}

/** Last settled assistant message's visible text (thinking excluded). */
function lastAssistantText(): string {
	for (let i = state.items.length - 1; i >= 0; i--) {
		const it = state.items[i];
		if (it.kind === "assistant") {
			const visible = it.blocks.filter(b => b.kind !== "thinking");
			return (visible.length > 0 ? visible : it.blocks).map(b => b.text).join("\n\n");
		}
	}
	return "";
}

/**
 * Phase 11: desktop notification, fired only when the tab is hidden and the
 * user opted in with granted permission. Non-secure contexts (typeof
 * Notification === "undefined") and denied/revoked permission are silent
 * no-ops — mirroring the TUI's OSC turn-complete notification.
 */
function maybeNotify(title: string, body: string): void {
	if (!state.notifyEnabled || !document.hidden) return;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	try {
		new Notification(title, body ? { body } : undefined);
	} catch {
		// Permission revoked between checks: silent no-op.
	}
}

/** Persisted desktop-notifications toggle; requests permission on first enable. */
export function setNotifyEnabled(enabled: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(NOTIFY_KEY, String(enabled));
	setState("notifyEnabled", enabled);
	if (enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
		// Denied is handled by the caller simply not getting notifications;
		// the request promise can reject in non-secure contexts.
		void Notification.requestPermission().catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Phase 11: /btw side panel (runEphemeralTurn relay). The panel owns a
// streamId that routes ephemeral_delta frames and abortEphemeral; nothing
// here touches the transcript or the main turn.
// ---------------------------------------------------------------------------
let nextEphemeralStreamId = 1;

/** Open the /btw panel and (with a question) start a side-channel turn. */
export function askBtw(question: string): void {
	const q = question.trim();
	if (!q) {
		// Bare /btw: open the panel empty; the hint explains the usage.
		setState("btw", { question: "", reply: "", streaming: false, streamId: -1 });
		return;
	}
	const streamId = nextEphemeralStreamId++;
	setState("btw", { question: q, reply: "", streaming: true, streamId });
	// Long-running side turn: no timeout (0); the panel's stop/close aborts it.
	void call("runEphemeralTurn", [q], 0, streamId)
		.then(result => {
			const replyText = (result as { replyText?: string } | null)?.replyText ?? "";
			setState("btw", prev =>
				prev && prev.streamId === streamId ? { ...prev, reply: replyText, streaming: false } : prev,
			);
		})
		.catch(err => {
			setState("btw", prev =>
				prev && prev.streamId === streamId ? { ...prev, streaming: false, error: String(err) } : prev,
			);
		});
}

/** Close the /btw panel; aborts the in-flight side turn server-side. */
export function closeBtw(): void {
	const current = state.btw;
	setState("btw", null);
	if (current?.streaming && current.streamId >= 0) {
		void call("abortEphemeral", [], 5_000, current.streamId).catch(() => {});
	}
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

/** Bang-shell/python item: appears immediately as a spinner, resolved by the call. */
export function addBashItem(command: string, dimmed: boolean, lang: "bash" | "python" = "bash"): number {
	const id = nextId++;
	pushItem({ kind: "bash", id, command, dimmed, lang, status: "running", output: "", exitCode: null, truncated: false });
	return id;
}

/** Live chunk from the server relay: append to the in-flight item's output. */
export function appendBashChunk(id: number, text: string): void {
	if (!text) return;
	const index = state.items.findIndex(it => it.kind === "bash" && it.id === id);
	if (index < 0) return;
	setState(
		"items",
		produce(items => {
			const item = items[index];
			// Chunks only stream while running; the completion result is
			// authoritative and replaces the buffered output wholesale.
			if (item?.kind !== "bash" || item.status !== "running") return;
			item.output = capTail(item.output + tabsToSpaces(text), 8000);
		}),
	);
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
				// Preserve streamed output: a failure mid-stream (timeout,
				// session switch, HTTP rejection) appends an error marker
				// instead of clobbering the buffer.
				const marker = `[error] ${result.error}`;
				const base = item.output.replace(/\n+$/, "");
				item.output = capTail(base ? `${base}\n${marker}` : marker, 8000);
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
			// Phase 11: desktop notification while the tab is hidden (OSC parity).
			maybeNotify("Turn complete", truncateHead(lastAssistantText(), 80));
			break;
		case "message_start": {
			const msg = e.message;
			if (msg.role === "user") {
				const images = scanImages(msg.content);
				pushItem({
					kind: "user",
					id: nextId++,
					text: userText(msg.content),
					...(images.length > 0 ? { images } : {}),
				});
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
				// Phase 9: per-turn usage comes from the settled message itself
				// (AssistantMessage.usage/ttft/duration in the message_end payload).
				const meta = msg as { usage?: UsageLike; ttft?: number; duration?: number };
				pushItem({
					kind: "assistant",
					id: nextId++,
					blocks: assistantBlocks(msg.content),
					usage: meta.usage,
					ttft: meta.ttft,
					duration: meta.duration,
				});
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
						if (item?.kind === "tool") {
							item.output = capTail(tabsToSpaces(extractText(e.partialResult)), 8000);
							const images = scanImages(e.partialResult);
							if (images.length > 0) item.images = images;
						}
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
							const images = scanImages(e.result);
							if (images.length > 0) item.images = images;
						}
					}),
				);
			break;
		}
		case "notice":
			pushItem({ kind: "notice", id: nextId++, level: e.level, message: e.message });
			// Phase 11: error-level notices (turn failure, failed retry, …) get
			// a notification too; the TUI surfaces these with an error OSC.
			if (e.level === "error") maybeNotify("Turn stopped with error", truncateHead(e.message, 80));
			break;
		case "thinking_level_changed":
			setState("thinkingLevel", e.thinkingLevel ?? undefined);
			break;
		case "goal_updated":
			// The event carries the full GoalModeState when available; fall back
			// to deriving a minimal active state from the goal payload.
			if (e.state) setState("goalModeState", e.state);
			else setState("goalModeState", e.goal ? { enabled: true, mode: "active", goal: e.goal } : undefined);
			setState("goal", e.goal ? { objective: e.goal.objective } : null);
			break;
		case "auto_retry_start":
			// Phase 9: live countdown badge in the status bar; notice stays.
			setState("retryInfo", {
				attempt: e.attempt,
				maxAttempts: e.maxAttempts,
				delayMs: e.delayMs,
				until: Date.now() + e.delayMs,
			});
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
			setState("retryInfo", null);
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

/**
 * History chunks accumulate here while a chunked history series is in flight
 * (a >4 MiB transcript primes as byte-bounded `history` frames, the last
 * tagged `final: true`). A frame without `final` is a complete transcript on
 * its own and flushes immediately; the accumulator resets on every `attached`
 * (each attach starts a fresh priming series).
 */
let pendingHistory: AgentMessage[] | null = null;

/**
 * Frame seqs already applied on THIS connection's prime window. A delta that
 * is live-delivered while the paced prime is in flight (the consumer attaches
 * before priming completes) is re-sent verbatim by the ring replay, so the
 * second copy must be dropped (finding #2 — without the guard, a resume or a
 * fresh attach during activity double-applies every delta that arrived after
 * the final history chunk). Cleared on every attach and every loadHistory:
 * a frame wiped by the rebuild is legitimately re-applied by the replay, and
 * seqs restart per connection, so only the overlap within one prime is tracked.
 */
const seenFrameSeqs = new Set<number>();

export function loadHistory(messages: AgentMessage[]): void {
	pendingDeltas.clear();
	// The rebuild wipes items pushed by any live-delivered delta since the
	// snapshot; the ring replay re-delivers those frames, so forget what was
	// seen before the rebuild (see seenFrameSeqs).
	seenFrameSeqs.clear();
	// Phase 5: reset id sequence so newly-switched sessions don't collide with
	// leftover ids from the prior transcript.
	nextId = 1;
	setState({ items: [], live: { active: false, blocks: [] }, retryInfo: null });
	for (const msg of messages) {
		if (msg.role === "user") {
			const images = scanImages(msg.content);
			pushItem({
				kind: "user",
				id: nextId++,
				text: userText(msg.content),
				...(images.length > 0 ? { images } : {}),
			});
		} else if (msg.role === "assistant") {
			const meta = msg as { usage?: UsageLike; ttft?: number; duration?: number };
			pushItem({
				kind: "assistant",
				id: nextId++,
				blocks: assistantBlocks(msg.content),
				usage: meta.usage,
				ttft: meta.ttft,
				duration: meta.duration,
			});
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
			const images = scanImages(msg);
			if (index >= 0) {
				setState(
					"items",
					produce(items => {
						const item = items[index];
						if (item?.kind === "tool") {
							item.output = output;
							item.status = status;
							if (images.length > 0) item.images = images;
						}
					}),
				);
			} else {
				pushItem({
					kind: "tool",
					id: nextId++,
					toolCallId: msg.toolCallId,
					name: msg.toolName,
					args: null,
					status,
					output,
					...(images.length > 0 ? { images } : {}),
				});
			}
		}
		// Any other role (developer, custom messages): skip.
	}
}

function applyState(s: WebSessionState, stats?: SessionStats): void {
	setState({
		model: s.model,
		modelRoles: s.modelRoles,
		modelRoleCatalog: s.modelRoleCatalog,
		modelRoleStorage: s.modelRoleStorage,
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
		goalModeState: s.goalModeState,
		planModeEnabled: s.planModeEnabled,
		fastModeEnabled: s.fastModeEnabled,
		computerToolEnabled: s.computerToolEnabled,
		inspectImageMode: s.inspectImageMode,
		// R8: state snapshots carry readyAt once the gate clears. Only apply it
		// when present so a pre-gate snapshot can't clobber a `ready` broadcast.
		...(s.readyAt !== undefined ? { readyAt: s.readyAt } : {}),
		...(stats !== undefined ? { stats } : {}),
	});
}

// ---------------------------------------------------------------------------
// Client-side debug ring (Debug panel): every transport lifecycle event lands
// here, oldest first; the panel renders the newest entry last. Capped ring —
// the oldest entries drop past DEBUG_RING_CAP.
// ---------------------------------------------------------------------------
export const DEBUG_RING_CAP = 300;

function pushDebug(level: DebugLevel, source: DebugEntry["source"], message: string): void {
	setState("debugLog", log => [...log.slice(-(DEBUG_RING_CAP - 1)), { ts: Date.now(), level, source, message }]);
}

// Transport (OMP_PROTO 2): EventSource downlink on GET /events (frame events),
// POST /command uplink. Native auto-reconnect sends Last-Event-ID for ring
// replay; `connected` is true between the first `open` and a terminal CLOSED
// (transient CONNECTING blips keep it true — the browser resumes the stream).
let events: EventSource | null = null;
let connected = false;

/** Silence deadline for the /events stream: any frame or ping re-arms it; a
 *  fire means the peer is dead — the socket is open but nothing is flowing
 *  (e.g. a hung middlebox) → teardown + reconnect. The daemon emits a named
 *  `ping` event every SSE_KEEPALIVE_MS precisely so this browser-side
 *  consumer can observe liveness. */
let silenceTimer: ReturnType<typeof setTimeout> | null = null;

/** (Re)arm the silence deadline from any downlink activity. */
function armSilenceTimer(): void {
	if (silenceTimer !== null) clearTimeout(silenceTimer);
	silenceTimer = setTimeout(() => {
		silenceTimer = null;
		if (!events) return; // already torn down / no live stream
		const dead = events;
		pushDebug("warn", "transport", "silence deadline hit — forcing reconnect");
		teardownStream(dead);
		// Reconnect immediately (no backoff delay): the server may be
		// perfectly healthy behind a hung middlebox. If the reconnect itself
		// fails, the CLOSED-onerror backoff ladder takes over.
		connect();
	}, SSE_SILENCE_DEADLINE_MS);
}

function clearSilenceTimer(): void {
	if (silenceTimer !== null) {
		clearTimeout(silenceTimer);
		silenceTimer = null;
	}
}

/** Teardown for a dead /events stream (terminal CLOSED or silence deadline):
 *  drop readiness and reject pendings. Does NOT schedule the reconnect —
 *  callers pick the delay (backoff ladder for CLOSED, immediate for silence). */
function teardownStream(source: EventSource): void {
	if (events !== source) return; // a newer connect() already superseded this stream
	pushDebug("info", "transport", "stream closed");
	clearSilenceTimer();
	connected = false;
	events = null;
	source.close();
	setState("connected", false);
	// Readiness is per-connection: the reconnecting stream's boot session
	// must clear its own gate before the composer un-gates again.
	setState("readyAt", undefined);
	rejectPendingCalls(new Error("Disconnected"));
	pendingSessions?.([]);
	pendingSessions = null;
	pendingFiles?.([]);
	pendingFiles = null;
	pendingProjects?.([]);
	pendingProjects = null;
	if (pendingAttach) {
		clearTimeout(pendingAttach.timer);
		pendingAttach.reject(new Error("Disconnected"));
		pendingAttach = null;
	}
	rejectPendingDaemons(new Error("Disconnected"));
}

/** Off-loopback bearer token from the page URL (?token=…); loopback dev needs none. */
let token: string | null = null;

/** One page-scoped client id: the fleet edge matches it across the /events
 *  stream and POST /command to route anonymous commands to the owning browser
 *  stream (a bare omp-session ignores both). Shown (truncated) in the Debug
 *  panel; not a secret — it already rides the query string and headers. */
export const clientId = crypto.randomUUID();

/**
 * Uplink: POST one ClientCommand to /command (202 fire-and-forget accept —
 * answers ride the /events stream only). A non-2xx rejects here so the
 * caller's pending promise settles instead of hanging until timeout.
 */
function postCommand(cmd: ClientCommand): Promise<void> {
	return fetch("/command", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-Omp-Client-Id": clientId, ...(token !== null ? { Authorization: `Bearer ${token}` } : {}) },
		body: JSON.stringify(cmd),
	}).then(res => {
		if (!res.ok) {
			pushDebug("error", "command", `command "${cmd.type}" rejected (HTTP ${res.status})`);
			throw new Error(`command "${cmd.type}" rejected (HTTP ${res.status})`);
		}
	});
}

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

export function call(method: WebMethodName, args: unknown[] = [], timeoutMs = 30_000, streamId?: number): Promise<unknown> {
	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	if (!connected) {
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
	// streamId tags server-side bash/python chunk frames so the client can
	// route them to the in-flight chat item (the bash item id).
	postCommand({ type: "call", id, method, args, ...(streamId !== undefined ? { streamId } : {}) } satisfies ClientCommand).catch(err => {
		pendingCalls.delete(id);
		clearTimeout(timer);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Roster mode with no daemon ever attached this tab; once attached, settings
 *  go through the session RPC for per-session option lists and live side
 *  effects. */
export function fleetSettingsActive(): boolean {
	return state.sessionMode === "roster" && state.currentSessionId === "";
}

/** Server error message from a non-ok /ctl response: the {error} body when
 *  present, else the raw body text, else the HTTP status. */
async function ctlError(res: Response): Promise<string> {
	const body = await res.text().catch(() => "");
	try {
		const parsed = JSON.parse(body) as { error?: unknown };
		if (typeof parsed.error === "string" && parsed.error !== "") return parsed.error;
	} catch {
		// non-JSON body — fall through to the raw text
	}
	return body || String(res.status);
}

// ---------------------------------------------------------------------------
// Settings model (TUI /settings parity). getSettings/setSetting return a
// fresh authoritative model each time; settings_changed frames keep every
// tab's settings panel in sync. With no daemon attached in roster mode the
// /ctl settings endpoints back the panel instead (config.yml writes apply to
// new sessions); the session RPC resumes once a session is attached.
// ---------------------------------------------------------------------------
export function refreshSettings(): void {
	setState("settingsLoading", true);
	const load = fleetSettingsActive()
		? fetch("/ctl/settings")
				.then(async res => {
					if (!res.ok) throw await ctlError(res);
					return (await res.json()) as SettingsModel;
				})
				.then(m => setState("settingsModel", m))
		: call("getSettings").then(m => setState("settingsModel", m as SettingsModel));
	load
		.catch(err => setState("error", String(err)))
		.finally(() => setState("settingsLoading", false));
}

/** Send one setting; the fresh model returned is authoritative, apply it. */
export function updateSetting(path: string, value: unknown): void {
	if (fleetSettingsActive()) {
		fetch("/ctl/settings/set", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path, value }),
		})
			.then(async res => {
				if (!res.ok) throw await ctlError(res);
				return (await res.json()) as SettingsModel;
			})
			.then(m => setState("settingsModel", m))
			.catch(err => setState("error", String(err)));
		return;
	}
	call("setSetting", [path, value])
		.then(m => setState("settingsModel", m as SettingsModel))
		.catch(err => setState("error", String(err)));
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
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingSessions?.([]);
	pendingSessions = resolve;
	postCommand({ type: "list_sessions", id: crypto.randomUUID() } satisfies ClientCommand).catch(err => {
		// Latest-wins: only clear the slot if a newer request hasn't claimed it.
		if (pendingSessions === resolve) pendingSessions = null;
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

export function listFiles(query: string, limit?: number): Promise<string[]> {
	const { promise, resolve, reject } = Promise.withResolvers<string[]>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingFiles?.([]);
	pendingFiles = resolve;
	postCommand({ type: "list_files", id: crypto.randomUUID(), query, limit } satisfies ClientCommand).catch(err => {
		// Latest-wins: only clear the slot if a newer request hasn't claimed it.
		if (pendingFiles === resolve) pendingFiles = null;
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

// ---------------------------------------------------------------------------
// Phase 3 fleet edge: roster-mode command senders. spawn/spawn_resume/
// stop are fire-and-forget — results arrive as roster + daemon_status
// broadcasts (spawn failures surface as an error frame). list_projects is a
// latest-wins pull like listSessions (the edge answers with one `projects`
// frame).
// ---------------------------------------------------------------------------
let pendingProjects: ((projects: ProjectEntry[]) => void) | null = null;

export function listProjects(): Promise<ProjectEntry[]> {
	const { promise, resolve, reject } = Promise.withResolvers<ProjectEntry[]>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	pendingProjects?.([]);
	pendingProjects = resolve;
	postCommand({ type: "list_projects", id: crypto.randomUUID() } satisfies ClientCommand).catch(err => {
		// Latest-wins: only clear the slot if a newer request hasn't claimed it.
		if (pendingProjects === resolve) pendingProjects = null;
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Spawn a new daemon from a repo/worktree path (validated edge-side; the
 *  resulting entry appears in the roster as it transitions spawning → ready). */
export function spawnDaemon(cwd: string, template?: string, labels?: string[]): void {
	if (!connected) return;
	void postCommand({
		type: "spawn",
		id: crypto.randomUUID(),
		cwd,
		...(template !== undefined ? { template } : {}),
		...(labels !== undefined ? { labels } : {}),
	} satisfies ClientCommand).catch(() => {});
}

/** Wake an asleep daemon (spawned → respawn --resume; attached/remote → redial). */
export function spawnResume(daemonId: string): void {
	if (!connected) return;
	void postCommand({ type: "spawn_resume", id: crypto.randomUUID(), daemonId } satisfies ClientCommand).catch(() => {});
}

/** Stop a daemon (spawned → terminate child; attached/remote → drop + asleep). */
export function stopDaemonById(daemonId: string): void {
	if (!connected) return;
	void postCommand({ type: "stop", id: crypto.randomUUID(), daemonId } satisfies ClientCommand).catch(() => {});
}

/** Stop a daemon AND evict it from the fleet roster (registry removal). */
export function removeDaemonById(daemonId: string): void {
	if (!connected) return;
	void postCommand({ type: "remove", id: crypto.randomUUID(), daemonId } satisfies ClientCommand).catch(() => {});
}

export function sendLoginCode(requestId: string, code: string): void {
	setState("loginCodeRequest", null);
	if (!connected) return;
	void postCommand({ type: "login_code", id: crypto.randomUUID(), requestId, code } satisfies ClientCommand).catch(() => {});
}

// Phase 3: answer the server's ui_request (ExtensionUIContext dialogs).
// Routing is by stream attachment — no sessionId on the command. The
// ui_request id doubles as the POST dedup id.
export function sendUiResponse(id: string, result: unknown): void {
	if (state.uiRequest?.id === id) setState("uiRequest", null);
	if (!connected) return;
	void postCommand({ type: "ui_response", id, result } satisfies ClientCommand).catch(() => {});
}

// Cancellation resolves the request undefined — NOT the error variant. The
// AskTool rich-dialog path (tools/ask.ts) maps an undefined result to
// ToolAbortError("Ask tool was cancelled by the user"); a rejected promise
// (`error` field) would surface the raw error text instead.
export function cancelUiRequest(id: string): void {
	if (state.uiRequest?.id === id) setState("uiRequest", null);
	if (!connected) return;
	void postCommand({ type: "ui_response", id } satisfies ClientCommand).catch(() => {});
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
// Fleet-edge attach. The edge answers `attach` with an id-keyed unicast
// `attach_result` frame (finding #28): the sessionId is the daemonId, and
// the daemon's own priming (history/state/available_commands) follows the
// proxied attached frame. A bare omp-session never receives attach (its
// sockets are attached from upgrade). An older edge that ignores the attach
// id never sends the keyed frame — the DAEMON_TIMEOUT_MS backstop settles
// the waiter then (#31-style pending map).
// ---------------------------------------------------------------------------
let pendingAttach: { id: string; resolve: (sessionId: string) => void; reject: (err: Error) => void; timer: number } | null = null;

function requestAttach(cmd: ClientCommand): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	// Latest-wins: a superseded attach resolves to whatever session is current.
	if (pendingAttach) {
		clearTimeout(pendingAttach.timer);
		pendingAttach.resolve(state.currentSessionId);
	}
	const id = cmd.id;
	const timer =
		DAEMON_TIMEOUT_MS > 0
			? window.setTimeout(() => {
					if (pendingAttach?.id === id) {
						pendingAttach = null;
						reject(new Error("attach timed out"));
					}
				}, DAEMON_TIMEOUT_MS)
			: 0;
	pendingAttach = { id, resolve, reject, timer };
	postCommand(cmd).catch(err => {
		if (pendingAttach?.id === id) {
			clearTimeout(pendingAttach.timer);
			pendingAttach = null;
		}
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Attach this tab to a daemon in the roster; resolves with its handle. */
export function attachSession(sessionId: string): Promise<string> {
	return requestAttach({ type: "attach", id: crypto.randomUUID(), sessionId });
}

// ---------------------------------------------------------------------------
// Daemon web exposure: per-daemon logs/stop/restart commands carry an explicit
// id and are answered by unicast daemon_logs_result / daemon_control_result
// frames, resolved through id-keyed pending maps (same timeout style as
// pendingCalls/call). Multiple commands may be in flight concurrently (e.g. a
// log refresh + a stop) so the maps are keyed by id rather than single-slot.
// ---------------------------------------------------------------------------

/** Result of requestDaemonLogs: tail/head text plus the broker log cursor. */
export type DaemonLogsResult = { text: string; cursor: number; state: string };

let nextDaemonCallId = 1;
const pendingDaemonLogs = new Map<string, { resolve: (r: DaemonLogsResult) => void; reject: (err: Error) => void; timer: number }>();
const pendingDaemonControl = new Map<string, { resolve: (d: DaemonInfo) => void; reject: (err: Error) => void; timer: number }>();

function rejectPendingDaemons(err: Error): void {
	for (const [id, p] of pendingDaemonLogs) {
		clearTimeout(p.timer);
		p.reject(err);
		pendingDaemonLogs.delete(id);
	}
	for (const [id, p] of pendingDaemonControl) {
		clearTimeout(p.timer);
		p.reject(err);
		pendingDaemonControl.delete(id);
	}
}

type DaemonControlCmd = Extract<ClientCommand, { type: "daemon_stop" | "daemon_restart" }>;
type DaemonLogsCmd = Extract<ClientCommand, { type: "daemon_logs" }>;
type DaemonPending<T> = Map<string, { resolve: (v: T) => void; reject: (err: Error) => void; timer: number }>;

const DAEMON_TIMEOUT_MS = 30_000;

function registerDaemonPending<T>(
	resolve: (v: T) => void,
	reject: (err: Error) => void,
	map: DaemonPending<T>,
): { id: string; timer: number } {
	const id = `d${nextDaemonCallId++}`;
	const timer =
		DAEMON_TIMEOUT_MS > 0
			? window.setTimeout(() => {
					map.delete(id);
					reject(new Error("daemon command timed out"));
				}, DAEMON_TIMEOUT_MS)
			: 0;
	map.set(id, { resolve, reject, timer });
	return { id, timer };
}

/** Fetch daemon log text (default tail 200 lines); resolves with text + broker cursor + state. */
export function requestDaemonLogs(
	projectDir: string,
	name: string,
	opts: { lines?: number; head?: boolean; grep?: string } = {},
): Promise<DaemonLogsResult> {
	const { promise, resolve, reject } = Promise.withResolvers<DaemonLogsResult>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	const cmd: Omit<DaemonLogsCmd, "id"> = {
		type: "daemon_logs",
		projectDir,
		name,
		lines: opts.lines ?? 200,
		...(opts.head !== undefined ? { head: opts.head } : {}),
		...(opts.grep !== undefined ? { grep: opts.grep } : {}),
	};
	const { id, timer } = registerDaemonPending<DaemonLogsResult>(resolve, reject, pendingDaemonLogs);
	postCommand({ ...cmd, id } satisfies ClientCommand).catch(err => {
		pendingDaemonLogs.delete(id);
		clearTimeout(timer);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Stop a daemon via its broker; resolves with the refreshed DaemonInfo. */
export function stopDaemon(projectDir: string, name: string): Promise<DaemonInfo> {
	const { promise, resolve, reject } = Promise.withResolvers<DaemonInfo>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	const cmd: Omit<Extract<ClientCommand, { type: "daemon_stop" }>, "id"> = { type: "daemon_stop", projectDir, name };
	const { id, timer } = registerDaemonPending<DaemonInfo>(resolve, reject, pendingDaemonControl);
	postCommand({ ...cmd, id } satisfies ClientCommand).catch(err => {
		pendingDaemonControl.delete(id);
		clearTimeout(timer);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Restart a daemon via its broker; resolves with the refreshed DaemonInfo. */
export function restartDaemon(projectDir: string, name: string): Promise<DaemonInfo> {
	const { promise, resolve, reject } = Promise.withResolvers<DaemonInfo>();
	if (!connected) {
		reject(new Error("Not connected"));
		return promise;
	}
	const cmd: Omit<Extract<ClientCommand, { type: "daemon_restart" }>, "id"> = { type: "daemon_restart", projectDir, name };
	const { id, timer } = registerDaemonPending<DaemonInfo>(resolve, reject, pendingDaemonControl);
	postCommand({ ...cmd, id } satisfies ClientCommand).catch(err => {
		pendingDaemonControl.delete(id);
		clearTimeout(timer);
		reject(err instanceof Error ? err : new Error(String(err)));
	});
	return promise;
}

/** Persisted roster-sidebar visibility (status-bar ☰ + sidebar ×). */
export function setSidebarVisible(visible: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(SIDEBAR_KEY, String(visible));
	setState("sidebarVisible", visible);
}

export function toggleSidebar(): void {
	setSidebarVisible(!state.sidebarVisible);
}

/** Persisted pet-roster visibility (status-bar segment + card ×). */
export function setPetVisible(visible: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(PET_KEY, String(visible));
	setState("petVisible", visible);
}

export function togglePetVisible(): void {
	setPetVisible(!state.petVisible);
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
		goalModeState: undefined,
		retryInfo: null,
		modal: null,
		loginUrl: null,
		loginCodeRequest: null,
		uiRequest: null,
		btw: null,
	});
}

let backoff = 1000;

export function connect(): void {
	// Browser-only transport: without EventSource there is nothing to dial.
	// (A bun test worker has neither EventSource nor location — a silence
	// timer armed by an earlier suite in the same worker must no-op here,
	// not crash on location.search.)
	if (typeof EventSource === "undefined") return;
	pushDebug("info", "transport", "connecting /events");
	// Same-origin http(s): EventSource for the downlink (native auto-reconnect
	// sends Last-Event-ID for ring replay) + POST /command for the uplink.
	// EventSource can't set headers, so the off-loopback bearer token rides
	// the query string when the page URL carries one; loopback dev needs none.
	clearSilenceTimer(); // a new connect() supersedes any prior stream's deadline
	token = new URLSearchParams(location.search).get("token") ?? null;
	const params = new URLSearchParams({ client: clientId });
	if (token !== null) params.set("token", token);
	const source = new EventSource(`/events?${params}`);
	events = source;
	armSilenceTimer();
	source.onopen = () => {
		backoff = 1000;
		connected = true;
		setState("connected", true);
		setState("reconnectDelay", 0);
		pushDebug("info", "transport", "stream open");
		// No boot-time calls: a roster-mode edge answers every call with
		// "not attached" until the browser picks a daemon. The attached handler
		// pulls getSubagents. On a roster-mode RECONNECT the edge has no attach
		// memory — re-attach to the daemon we were viewing.
		if (state.sessionMode === "roster" && state.currentSessionId) void attachSession(state.currentSessionId).catch(() => {});
	};
	source.addEventListener(SSE_EVENT_NAME, ev => {
		armSilenceTimer(); // any downlink activity means the peer is alive
		setState("lastFrameAt", Date.now());
		const frame = JSON.parse(String((ev as MessageEvent).data)) as ServerFrame;
		if (frame.type === "attached") {
			pushDebug("info", "transport", `attached ${frame.sessionId}`);
			const switched = state.currentSessionId !== "" && state.currentSessionId !== frame.sessionId;
			setState("currentSessionId", frame.sessionId);
			// Every attach re-primes history from scratch: drop any in-flight
			// chunked-series accumulation from the previous attach/session.
			pendingHistory = null;
			// A fresh priming series starts; the replay-dedup window resets
			// (seqs restart per connection, see seenFrameSeqs).
			seenFrameSeqs.clear();
			// Phase 6: there is no mux to switch to. In roster mode the attached
			// frame is PROXIED from the daemon and must not clobber the roster
			// sidebar; the roster frame owns sessionMode there.
			if (state.sessionMode !== "roster") setState("sessionMode", "single");
			// Finding #28: the attach waiter settles from the edge's id-keyed
			// attach_result, never from this PROXIED frame — the priming rides
			// the daemon pipe, which may be mid-redial when the attach lands.
			if (switched) {
				// In-flight calls belonged to the previous session; their results
				// are stale now and would be filtered out below. Clean up BEFORE
				// the getSubagents pull below, or rejectPendingCalls would kill the
				// fresh call too (and resetSessionView wipes its populated result).
				rejectPendingCalls(new Error("session switched"));
				resetSessionView();
				// Phase 3 daemon switch: drop readiness too. The edge only pipes
				// daemons that passed waitReady, so the proxied priming re-delivers
				// `ready` immediately; until then the composer stays gated and the
				// roster hint shows the session's status.
				setState("readyAt", undefined);
			}
			// Subagent mirror is per-session; pull on EVERY attach (first attach,
			// switch, roster re-attach after reconnect) — calls are answered only
			// once attached, so this is the earliest safe point.
			void call("getSubagents")
				.then(subs => {
					const next = new Map<string, SubagentInfo>();
					for (const s of subs as SubagentInfo[]) if (s.id) next.set(s.id, s);
					setState("subagents", next);
				})
				.catch(() => {});
			return;
		}
		// Stale-frame guard: session-scoped frames for a handle this tab no
		// longer views (in flight during a switch) are dropped. Frames WITHOUT
		// a sessionId (standalone omp-session: one live session, connect = attached)
		// always pass — there is nothing to mismatch. attach_result is a unicast
		// answer whose sessionId is the ATTACHED daemonId (finding #28) and must
		// pass too — id-matching against pendingAttach handles staleness.
		if (frame.type !== "attach_result" && "sessionId" in frame && frame.sessionId !== state.currentSessionId) return;
		// Replay-dedup guard (finding #2): a delta live-delivered during the
		// paced prime is re-sent verbatim by the ring replay. Its seq was seen
		// on this connection already, so the second copy is the replay — drop
		// it (see seenFrameSeqs; native EventSource exposes the SSE id as
		// MessageEvent.lastEventId, absent for ping/undecorated frames).
		const frameSeq = Number((ev as MessageEvent).lastEventId);
		if (Number.isFinite(frameSeq) && frameSeq > 0 && seenFrameSeqs.has(frameSeq)) return;
		switch (frame.type) {
			case "history": {
				// A transcript over the SSE backpressure cap primes as
				// sequential frames (final: false … final: true); a frame
				// WITHOUT `final` (the original single-frame shape) is complete
				// on its own. Reassemble before loadHistory — it rebuilds items
				// from the whole transcript, so a partial load would lose data.
				if (frame.final === undefined) {
					pendingHistory = null;
					loadHistory(frame.messages);
				} else if (frame.final) {
					const all = pendingHistory === null ? frame.messages : pendingHistory.concat(frame.messages);
					pendingHistory = null;
					loadHistory(all);
				} else {
					pendingHistory = pendingHistory === null ? frame.messages.slice() : pendingHistory.concat(frame.messages);
				}
				break;
			}
			case "state":
				applyState(frame.state, frame.stats);
				break;
			case "ready":
				// R8: the boot session's readiness gate cleared; the composer
				// un-gates. A stamped state frame may have set readyAt already;
				// this later broadcast wins either way.
				setState("readyAt", frame.readyAt);
				break;
			case "event":
				applyEvent(frame.event);
				break;
			case "bash_chunk":
				appendBashChunk(frame.id, frame.text);
				break;
			case "python_chunk":
				appendBashChunk(frame.id, frame.text);
				break;
			case "ephemeral_delta": {
				// Phase 11: /btw side-panel stream; route by streamId, ignore
				// stale frames from a superseded question.
				if (state.btw?.streaming && frame.id === state.btw.streamId) {
					setState("btw", "reply", reply => reply + frame.text);
				}
				break;
			}
			case "call_result": {
				const pending = pendingCalls.get(frame.id);
				if (!pending) break; // unknown id (timed out or stale): ignore
				pendingCalls.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.ok) pending.resolve(frame.data);
				else pending.reject(new Error(frame.error ?? "call failed"));
				break;
			}
			case "attach_result": {
				// Finding #28: the edge answers attach with this id-keyed
				// unicast; unrelated global error frames never settle the
				// waiter. Unknown id = superseded/timed out: ignore.
				if (!pendingAttach || pendingAttach.id !== frame.id) break;
				clearTimeout(pendingAttach.timer);
				const pending = pendingAttach;
				pendingAttach = null;
				if (frame.ok && frame.sessionId !== undefined) {
					pending.resolve(frame.sessionId);
					pushDebug("info", "transport", `attach ok: ${frame.sessionId}`);
				} else {
					pending.reject(new Error(frame.error ?? "attach failed"));
					pushDebug("warn", "transport", `attach failed: ${frame.error ?? "unknown error"}`);
				}
				break;
			}
			case "available_commands":
				setState("availableCommands", frame.commands);
				break;
			case "sessions":
				pendingSessions?.(frame.sessions);
				pendingSessions = null;
				break;
			case "daemons":
				setState("daemons", new Map((frame.daemons as DaemonInfo[] | undefined ?? []).map(d => [daemonsKey(d), d])));
				break;
			case "roster":
				// The fleet edge sent its daemon roster — this tab is in
				// roster mode (sidebar swaps to the session list). The attached
				// frame carries no mode; this frame is the mode signal, and it
				// must not be undone by the proxied attached frames (handled
				// above).
				setState("daemonRoster", frame.daemons);
				setState("sessionMode", "roster");
				pushDebug("info", "roster", `roster frame: ${frame.daemons.length} daemon${frame.daemons.length === 1 ? "" : "s"}`);
				break;
			case "daemon_status":
				// Patch the matching roster entry in place; the error field
				// clears unless the frame carries a fresh one.
				setState("daemonRoster", roster =>
					roster.map(d =>
						d.daemonId === frame.daemonId
							? { ...d, status: frame.status, ...(frame.error !== undefined ? { error: frame.error } : { error: undefined }) }
							: d,
					),
				);
				pushDebug(
					frame.status === "error" || frame.error !== undefined ? "error" : "info",
					"roster",
					`daemon ${frame.daemonId.slice(0, 8)} → ${frame.status}${frame.error !== undefined ? `: ${frame.error}` : ""}`,
				);
				break;
			case "projects":
				pendingProjects?.(frame.projects);
				pendingProjects = null;
				break;
			case "daemon_logs_result": {
				const pending = pendingDaemonLogs.get(frame.id);
				if (!pending) break; // unknown id (timed out or stale): ignore
				pendingDaemonLogs.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.ok && frame.text !== undefined && frame.cursor !== undefined && frame.state !== undefined) {
					pending.resolve({ text: frame.text, cursor: frame.cursor, state: frame.state });
				} else {
					pending.reject(new Error(frame.error ?? "daemon logs failed"));
				}
				break;
			}
			case "daemon_control_result": {
				const pending = pendingDaemonControl.get(frame.id);
				if (!pending) break; // unknown id (timed out or stale): ignore
				pendingDaemonControl.delete(frame.id);
				clearTimeout(pending.timer);
				if (frame.ok && frame.daemon) pending.resolve(frame.daemon);
				else pending.reject(new Error(frame.error ?? "daemon control failed"));
				break;
			}
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
					// Finding #30: progress frames can arrive BEFORE the lifecycle
					// frame — the progress handler created a `progress-${index}`
					// placeholder. Migrate it into the real-id entry so the strip
					// never shows two rows for one subagent, and keep the data the
					// placeholder accumulated (task, and status when the lifecycle
					// frame omits it) that this frame doesn't carry.
					const placeholder = p.index !== undefined ? next.get(`progress-${p.index}`) : undefined;
					if (placeholder) next.delete(`progress-${p.index}`);
					next.set(p.id as string, {
						id: p.id as string,
						index: p.index ?? existing?.index ?? placeholder?.index ?? -1,
						agent: p.agent ?? existing?.agent ?? placeholder?.agent ?? "agent",
						description: p.description ?? existing?.description,
						task: existing?.task ?? placeholder?.task,
						status: p.status ?? placeholder?.status ?? "started",
						lastUpdate: Date.now(),
						parentToolCallId: p.parentToolCallId ?? existing?.parentToolCallId ?? placeholder?.parentToolCallId,
					});
					return next;
				});
				break;
			}
			case "subagent_progress": {
				const p = frame.payload as { index?: number; agent?: string; task?: string; progress?: { status?: string }; parentToolCallId?: string } | undefined;
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
							parentToolCallId: p.parentToolCallId,
						});
					}
					const entry = next.get(key);
					if (entry) {
						if (p.task !== undefined) entry.task = p.task;
						if (p.parentToolCallId !== undefined) entry.parentToolCallId = p.parentToolCallId;
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
			case "ui_request_end":
				// Finding #16: the dialog settled (answered/rejected). Dismiss
				// it if it's the one shown — the ring replay delivers this
				// AFTER a stale ui_request on resume, so an answered dialog
				// never reappears as a hanging modal.
				if (state.uiRequest?.id === frame.id) setState("uiRequest", null);
				break;
			case "settings_changed": {
				// Session-scoped broadcast: a fresh model after any setSetting,
				// so every attached tab's panel stays in sync.
				const model = (frame as { model: SettingsModel }).model;
				setState("settingsModel", model);
				break;
			}
			case "error":
				// Finding #28: an error frame is a GLOBAL uncorrelated broadcast
				// (fire-and-forget spawn failures, a lost pipe for ANOTHER
				// daemon, "not attached" answers) — it must never settle an
				// in-flight attach. Attach failures arrive as id-keyed
				// attach_result frames; global errors only display.
				setState("error", frame.error);
				pushDebug("error", "transport", `error frame: ${frame.error}`);
				break;
			case "hello_ok":
				// Finding #61: the browser enforces OMP_PROTO too. Standalone
				// priming leads with hello_ok; the fleet edge forwards the
				// (pipe-gated) hello_ok in roster mode. A mismatch is terminal
				// — mirror the connector's fail-closed semantics: surface the
				// error, tear the stream down, and do NOT schedule the
				// reconnect (the backoff loop in onerror would otherwise hot-loop
				// against an undrivable daemon).
				if (frame.proto !== OMP_PROTO) {
					setState("error", `proto mismatch: daemon speaks OMP_PROTO ${String(frame.proto)}, expected ${OMP_PROTO}`);
					pushDebug("error", "transport", `proto mismatch: daemon speaks ${String(frame.proto)}, expected ${OMP_PROTO}`);
					teardownStream(source);
					return;
				}
				break;
			default:
				// Anything else unknown is tolerated and ignored, never thrown.
				console.debug(`[omp-session] ignoring ${frame.type} frame`);
				break;
		}
		if (Number.isFinite(frameSeq) && frameSeq > 0) seenFrameSeqs.add(frameSeq);
	});
	source.addEventListener(SSE_PING_EVENT, () => {
		// Keepalive tick: the server is alive (the stream is not silently
		// hung). Re-arm the silence deadline. The wire block carries no id,
		// so this never advances Last-Event-ID / ring replay.
		armSilenceTimer();
		setState("lastFrameAt", Date.now());
	});
	source.onerror = () => {
		// Terminal (401 or fatal): EventSource gives up (readyState CLOSED) and
		// will NOT retry. Teardown like a socket close, then manually reconnect
		// with the same 1s→8s backoff — auth failures must not hot-loop.
		if (source.readyState !== EventSource.CLOSED) {
			pushDebug("info", "transport", "transient blip — native auto-reconnect");
			return; // transient blip: native auto-reconnect resumes with Last-Event-ID
		}
		teardownStream(source); // no-op if a newer connect() superseded this stream
		const delay = backoff;
		backoff = Math.min(backoff * 2, 8000);
		setState("reconnectDelay", delay);
		pushDebug("warn", "transport", `connection lost — retrying in ${delay}ms`);
		setTimeout(connect, delay);
	};
}
