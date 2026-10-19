import { createSignal } from "solid-js";
import { produce } from "solid-js/store";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { ImageArg, QueuedCommandRef, QueuedMessageRef } from "#lib/wire/protocol";
import { scanImages } from "../text/images";
import { promptTimestamp } from "../chat/turn-usage";
import { smoothStreaming } from "../chat/display-prefs";
import type { UsageLike } from "../usage/usage";
import {
	setState,
	state,
	type BashResultLike,
	type Block,
	type ChatItem,
	type CompactionItem,
	type PromptInsert,
} from "../state";
import { splitTextAttachments } from "../prompt/attachments";
import { isReady } from "./session";
import { call } from "./transport";
import { reportError } from "./toasts";
import { advisorNotesOf } from "./slices/advisor";
import { noticeAdvisorNotesWhileOff } from "./advisor-notice";
import { collabLive, guestPromptOf } from "./slices/collab";
import { flushBtwEphemeral } from "./slices/btw";
import { applyGoalUpdated } from "./slices/goals";
import { settingValue } from "./settings";
import { requestDangerConfirm } from "../prompt/danger-confirm";
import {
	NOTIFY_SETTING_PATH,
	notifyKindEnabled,
	turnCompleted,
	turnFailure,
	type NotifyKind,
} from "./notify";

/**
 * Chat/streaming domain (Phase 3 store facade split). Everything that mutates
 * the transcript (`items`/`live`), the /btw side panel reply buffer, and the
 * rAF-coalesced write machinery moved here from state.ts; state.ts re-exports
 * the public actions so call sites stay byte-identical. The store itself and
 * the connect()/SSE mux remain in state.ts. This module's buffered maps are
 * drained by the single flushDeltas rAF loop and called into by the mux.
 */

/** localStorage key for the Phase 11 desktop-notifications toggle. */
const NOTIFY_KEY = "omp.notifyEnabled";

let nextId = 1;

/** Reset the transcript id sequence (history rebuild / session switch). */
export function resetChatIds(): void {
	nextId = 1;
}

/**
 * A turn that is not streaming has no tool in flight. A replayed transcript
 * opens an unanswered tool call as running (its result is written only when the
 * tool returns), so an idle snapshot settles any such leftover here.
 */
export function settleRunningTools(): void {
	if (!state.items.some((it) => it.kind === "tool" && it.status === "running")) return;
	setState(
		"items",
		produce((items) => {
			for (const item of items) {
				if (item.kind === "tool" && item.status === "running") item.status = "done";
			}
		}),
	);
}

/** Allocate the next transcript item id. */
export function nextChatId(): number {
	return nextId++;
}

export function tabsToSpaces(s: string): string {
	return s.replace(/\t/g, "  ");
}

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

export function capTail(s: string, max: number): string {
	return s.length > max ? s.slice(-max) : s;
}

export function extractText(value: unknown): string {
	if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
		const parts: string[] = [];
		for (const c of value.content) {
			if (
				c &&
				typeof c === "object" &&
				"type" in c &&
				c.type === "text" &&
				"text" in c &&
				typeof c.text === "string"
			) {
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

export function userText(content: UserContent): string {
	if (typeof content === "string") return tabsToSpaces(content);
	return tabsToSpaces(content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n"));
}

/**
 * First ~max code points of a string, never splitting a surrogate pair.
 * The desktop-notification body is capped so the OS banner stays readable.
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
			const visible = it.blocks.filter((b) => b.kind !== "thinking");
			return (visible.length > 0 ? visible : it.blocks).map((b) => b.text).join("\n\n");
		}
	}
	return "";
}

/**
 * Desktop notification for one event kind. The SDK setting for that kind
 * (`completion.notify`, `error.notify`, `ask.notify`) decides whether it
 * notifies; the local toggle is the browser-permission grant. Fires only while
 * the tab is hidden. Non-secure contexts (typeof Notification === "undefined")
 * and denied/revoked permission are silent no-ops.
 */
export function notifyDesktop(kind: NotifyKind, title: string, body: string): void {
	if (!state.notifyEnabled || !document.hidden) return;
	if (!notifyKindEnabled(kind, settingValue(NOTIFY_SETTING_PATH[kind]))) return;
	if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
	try {
		new Notification(title, body ? { body } : undefined);
	} catch {
		// Permission revoked between checks: silent no-op.
	}
}

/** Ctrl+O and the header kebab: expand or collapse every tool card at once. */
export function toggleToolsExpanded(): void {
	setState("toolsExpanded", (v) => !v);
}

/** Persisted desktop-notifications toggle; requests permission on first enable. */
export function setNotifyEnabled(enabled: boolean): void {
	if (typeof localStorage !== "undefined") localStorage.setItem(NOTIFY_KEY, String(enabled));
	setState("notifyEnabled", enabled);
	if (enabled && typeof Notification !== "undefined" && Notification.permission === "default") {
		// Denied is handled by the caller not getting notifications;
		// the request promise can reject in non-secure contexts.
		void Notification.requestPermission().catch(() => {});
	}
}

/** True when the browser has denied notification permission, so the toggle cannot take effect. */
export function notificationsBlocked(): boolean {
	return typeof Notification !== "undefined" && Notification.permission === "denied";
}

export function pushItem(item: ChatItem): void {
	setState("items", (items) => [...items, item]);
}

export function pushNotice(level: string, message: string): void {
	pushItem({ kind: "notice", id: nextId++, level, message });
	// finding #P1: error-level notices are status messages; announce them so
	// screen-reader users hear them without focus being yanked.
	if (level === "error") announceIfReady(message);
}

export function announce(text: string): void {
	if (state.announcement === text) return;
	setState("announcement", text);
}

/** Session-scoped announcements: silent until the boot readiness gate clears
 *  (priming/history replay must not announce). Roster transitions are NOT
 *  gated here; they are fleet-scoped and diffed against first sighting. */
function announceIfReady(text: string): void {
	if (isReady()) announce(text);
}

export function pushCompaction(item: Omit<CompactionItem, "kind" | "id">): void {
	pushItem({ kind: "compaction", id: nextId++, ...item });
}

/** Bang-shell/python item: appears immediately as a spinner, resolved by the call. */
export function addBashItem(
	command: string,
	dimmed: boolean,
	lang: "bash" | "python" = "bash",
): number {
	const id = nextId++;
	pushItem({
		kind: "bash",
		id,
		command,
		dimmed,
		lang,
		status: "running",
		output: "",
		exitCode: null,
		truncated: false,
	});
	return id;
}

/** Live chunk from the server relay: append to the in-flight item's output. */
export function appendBashChunk(id: number, text: string): void {
	if (!text) return;
	const index = state.items.findIndex((it) => it.kind === "bash" && it.id === id);
	if (index < 0) return;
	// Buffered into the rAF flush and coalesced by item id: N chunks between
	// flushes = 1 store write (≤60/s cap preserved). resolveBashItem drains
	// this key first so the authoritative result never interleaves with
	// streamed text.
	const pending = pendingBashChunks.get(id);
	pendingBashChunks.set(id, pending === undefined ? text : pending + text);
	scheduleFlush();
}

export function resolveBashItem(id: number, result: BashResultLike | { error: string }): void {
	const index = state.items.findIndex((it) => it.kind === "bash" && it.id === id);
	if (index < 0) return;
	// Synchronous transition: any buffered stream chunks land first so the
	// error marker appends to (and the success result replaces) ALL streamed
	// text. Output is never lost or reordered by a pending flush.
	drainBashChunk(id, index);
	setState(
		"items",
		produce((items) => {
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

export function findToolIndex(toolCallId: string): number {
	return state.items.findIndex((it) => it.kind === "tool" && it.toolCallId === toolCallId);
}

// Token deltas are buffered and applied at most once per animation frame,
// capping store writes at ≤60/s regardless of provider chunk rate.
const pendingDeltas = new Map<number, { kind: Block["kind"]; text: string }>();

/** Drop all buffered token deltas (history rebuild / session reset). */
export function clearPendingDeltas(): void {
	pendingDeltas.clear();
}

// Phase 1: SSE-frame text writes share the same rAF flush, coalescing N
// frames between flushes into 1 store write per target key. Keys are stable
// ids (toolCallId / bash item id / btw streamId). Unlike pendingDeltas'
// positional block indices, a flush can never apply to the wrong item.
// ONLY text/chunk appends and running-status text updates are buffered here;
// state transitions (tool_execution_end, resolveBashItem, call_result, stream
// close) stay synchronous and drain the matching key first so output is never
// lost or reordered. Tool partials REPLACE the card's output (last frame
// wins); bash/python chunks and btw deltas APPEND (frames coalesce).
const pendingToolUpdates = new Map<string, { output: string; images: ImageArg[] }>();
const pendingBashChunks = new Map<number, string>();
export const pendingEphemeral = new Map<number, string>();
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

export function scheduleFlush(): void {
	if (rafId !== 0) return;
	// Bun's test environment has no rAF; drain on a microtask instead so
	// buffered writes still land (tests flush via their microtask helpers).
	if (typeof requestAnimationFrame === "function") {
		rafId = requestAnimationFrame(flushDeltas);
	} else {
		queueMicrotask(() => {
			rafId = 0;
			flushDeltas();
		});
	}
}

function flushDeltas(): void {
	rafId = 0;
	if (
		pendingDeltas.size === 0 &&
		pendingToolUpdates.size === 0 &&
		pendingBashChunks.size === 0 &&
		pendingEphemeral.size === 0
	) {
		return;
	}

	// Coalesced SSE-frame writes: at most one store write per target key per
	// flush (the rAF cadence caps this at ≤60/s). The maps touch disjoint
	// store paths (items vs btw.reply vs live.blocks), so application order
	// between them is unconstrained.
	if (pendingToolUpdates.size > 0) {
		setState(
			"items",
			produce((items) => {
				for (const [toolCallId, update] of pendingToolUpdates) {
					const item =
						items[items.findIndex((it) => it.kind === "tool" && it.toolCallId === toolCallId)];
					if (item?.kind !== "tool") continue;
					item.output = capTail(update.output, 8000);
					if (update.images.length > 0) item.images = update.images;
				}
			}),
		);
		pendingToolUpdates.clear();
	}
	if (pendingBashChunks.size > 0) {
		setState(
			"items",
			produce((items) => {
				for (const [id, text] of pendingBashChunks) {
					const item = items[items.findIndex((it) => it.kind === "bash" && it.id === id)];
					// Chunks only stream while running; the completion result is
					// authoritative and replaces the buffered output wholesale.
					if (item?.kind !== "bash" || item.status !== "running") continue;
					item.output = capTail(item.output + tabsToSpaces(text), 8000);
				}
			}),
		);
		pendingBashChunks.clear();
	}
	if (pendingEphemeral.size > 0) {
		flushBtwEphemeral(state.btw, pendingEphemeral, (text) =>
			setState("btw", "reply", (reply) => reply + text),
		);
	}

	// Use the same clock as drainDeadline, since rAF callback timestamps are not
	// guaranteed to be comparable (headless BeginFrame can schedule them ahead).
	const now = performance.now();
	let budget = Number.POSITIVE_INFINITY;
	if (smoothStreaming()) {
		const dt = Math.min(Math.max((now - lastFlushTime) / 1000, 0), 0.1) || 1 / 60;
		let backlog = 0;
		for (const d of pendingDeltas.values()) backlog += d.text.length;
		const timeLeft = Math.max(drainDeadline - now, dt * 1000);
		const rate = Math.max(REVEAL_BASE_CHARS_PER_SEC, backlog / (timeLeft / 1000));
		budget = Math.max(1, Math.round(rate * dt));
	}
	lastFlushTime = now;
	let wroteLiveText = false;
	for (const [index, d] of pendingDeltas) {
		if (budget <= 0) break;
		const cut = budget >= d.text.length ? d.text.length : codePointCut(d.text, budget);
		if (state.live.blocks[index]?.kind !== d.kind) ensureLiveBlock(index, d.kind);
		// In-place path mutation keeps block identity stable, so <For> does not
		// recreate StreamingBlock components on every frame.
		setState("live", "blocks", index, "text", (text) => text + tabsToSpaces(d.text.slice(0, cut)));
		wroteLiveText = true;
		if (cut >= d.text.length) pendingDeltas.delete(index);
		else d.text = d.text.slice(cut);
		budget -= cut;
	}
	if (wroteLiveText) bumpLiveRev();
	if (pendingDeltas.size > 0) scheduleFlush();
}

/** Monotonic content version of live.blocks: bumped on every live-block
 *  mutation so scroll/pin effects subscribe to "content changed" without
 *  scanning block text lengths on every flush. */
function bumpLiveRev(): void {
	setState("live", "rev", (rev) => rev + 1);
}

/** Apply a buffered tool partial for one card synchronously (drain on
 *  tool_execution_end so the authoritative final result replaces ALL partial
 *  text; a late flush must never clobber the settled output). */
function drainToolUpdate(toolCallId: string, index: number): void {
	const update = pendingToolUpdates.get(toolCallId);
	if (update === undefined) return;
	pendingToolUpdates.delete(toolCallId);
	setState(
		"items",
		produce((items) => {
			const item = items[index];
			if (item?.kind !== "tool") return;
			item.output = capTail(update.output, 8000);
			if (update.images.length > 0) item.images = update.images;
		}),
	);
}

/** Apply the buffered chunk for one bash item synchronously (drain on
 *  resolveBashItem so streamed text lands before the result replaces it). */
function drainBashChunk(id: number, index: number): void {
	const text = pendingBashChunks.get(id);
	if (text === undefined) return;
	pendingBashChunks.delete(id);
	setState(
		"items",
		produce((items) => {
			const item = items[index];
			if (item?.kind !== "bash" || item.status !== "running") return;
			item.output = capTail(item.output + tabsToSpaces(text), 8000);
		}),
	);
}

function ensureLiveBlock(contentIndex: number, kind: Block["kind"]): void {
	if (state.live.blocks[contentIndex]?.kind === kind) return;
	setState("live", "blocks", (blocks) => {
		if (blocks[contentIndex]?.kind === kind) return blocks;
		const next = blocks.slice();
		next[contentIndex] = { kind, text: next[contentIndex]?.text ?? "" };
		return next;
	});
	// A block appeared or changed kind at contentIndex (text preserved):
	// scroll/pin trackers hear about it even though no text was written
	// (text_start/thinking_start frames).
	bumpLiveRev();
}

export function assistantBlocks(content: AssistantContent): Block[] {
	const blocks: Block[] = [];
	for (const c of content) {
		if (c.type === "text") blocks.push({ kind: "text", text: tabsToSpaces(c.text) });
		else if (c.type === "thinking")
			blocks.push({ kind: "thinking", text: tabsToSpaces(c.thinking) });
	}
	return blocks;
}

/** Working-label intent from a tool_execution_start event, TUI priority:
 *  the loop's resolved `intent` first, then the harness-injected `i` arg
 *  (INTENT_FIELD in pi-wire, kept a literal because pi-wire isn't a client
 *  dependency). Non-strings arrive from partial JSON; ignore them. */
function extractWorkingIntent(
	e: Extract<AgentSessionEvent, { type: "tool_execution_start" }>,
): string | undefined {
	// tools.intentTracing off: the SDK injects no intent (sdk.ts:3958), so no label.
	if (!(settingValue<boolean>("tools.intentTracing") ?? true)) return undefined;
	const fromEvent = typeof e.intent === "string" ? e.intent.trim() : "";
	if (fromEvent) return fromEvent;
	const args = e.args;
	if (args && typeof args === "object" && !Array.isArray(args)) {
		const i = (args as Record<string, unknown>).i;
		if (typeof i === "string" && i.trim()) return i.trim();
	}
	return undefined;
}

export function applyEvent(e: AgentSessionEvent): void {
	switch (e.type) {
		case "agent_start":
			setState("streaming", true);
			setState("workingIntent", undefined);
			// A new turn supersedes any unviewed-answer flag from the previous
			// one (the dot reads in_progress for the duration regardless).
			setState("answerUnviewed", false);
			// finding #P1: the agent turn became audible; announce the flip.
			announceIfReady("agent started");
			break;
		case "agent_end":
			// The final message content is authoritative (message_end pushes the
			// full item); leftover queue entries must not leak into the next message.
			pendingDeltas.clear();
			setState("live", "active", false);
			setState("workingIntent", undefined);
			// SDK continuations (retry, compaction, stop reminders) settle the
			// current message without finishing the turn. Keep the composer busy
			// until a yield; older producers omit this optional field.
			if (e.yielded === false) break;
			setState("streaming", false);
			// Turn finished below the viewport (user is scrolled up): flag the
			// answer as unviewed so the roster row shows the yellow unreviewed
			// dot until the user scrolls to the live edge.
			if (!state.chatPinned) setState("answerUnviewed", true);
			// Chat-mode dot: the turn ended while the user is in Analysis; the
			// Chat button lights up until setView("chat") clears it.
			if (state.view === "analysis") setState("chatUnviewed", true);
			// finding #P1: turn ended (streamed text itself is never announced).
			announceIfReady("agent finished");
			// Phase 11: desktop notification while the tab is hidden (OSC parity).
			if (turnCompleted(e.messages))
				notifyDesktop("completion", "Turn complete", truncateHead(lastAssistantText(), 80));
			// Error notification mirrors SDK sendErrorNotification: fired at agent_end, not from the error notice.
			{
				const failure = turnFailure(e.messages, {
					terminal: e.isTerminal !== false,
					retryPending: state.retryInfo !== null,
				});
				if (failure !== undefined)
					notifyDesktop("error", "Turn stopped with error", truncateHead(failure, 80));
			}
			break;
		case "message_start": {
			const msg = e.message;
			if (msg.role === "user") {
				const images = scanImages(msg.content);
				const stamp = promptTimestamp(msg);
				pushItem({
					kind: "user",
					id: nextId++,
					text: userText(msg.content),
					...(images.length > 0 ? { images } : {}),
					...(stamp !== undefined ? { timestamp: stamp } : {}),
				});
			} else if (msg.role === "assistant") {
				setState("live", { active: true, blocks: [] });
				// blocks was replaced wholesale (identity change): bump rev so
				// scroll/pin trackers re-check even though no text was written.
				bumpLiveRev();
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
				const meta = msg as {
					usage?: UsageLike;
					ttft?: number;
					duration?: number;
					completedAt?: number;
					stopReason?: string;
				};
				pushItem({
					kind: "assistant",
					id: nextId++,
					blocks: assistantBlocks(msg.content),
					usage: meta.usage,
					ttft: meta.ttft,
					duration: meta.duration,
					...(meta.completedAt !== undefined ? { completedAt: meta.completedAt } : {}),
					...(meta.stopReason === "aborted" ? { interrupted: true } : {}),
				});
				setState("live", "active", false);
			} else {
				// Advisor cards (steered or preserved) settle as custom messages.
				const notes = advisorNotesOf(msg);
				if (notes !== null) {
					pushItem({ kind: "advisor", id: nextId++, notes });
					noticeAdvisorNotesWhileOff(notes.length);
				}
				const guest = guestPromptOf(msg);
				if (guest !== null) pushItem({ kind: "guestPrompt", id: nextId++, ...guest });
			}
			break;
		}
		case "tool_execution_start": {
			pushItem({
				kind: "tool",
				id: nextId++,
				toolCallId: e.toolCallId,
				name: e.toolName,
				args: e.args ?? null,
				status: "running",
				output: "",
			});
			// TUI parity (event-controller #updateWorkingMessageFromIntent): the
			// working label tracks the latest call's intent; last one wins.
			const intent = extractWorkingIntent(e);
			if (intent) setState("workingIntent", intent);
			// finding #P1: tool run lifecycle is a status message.
			announceIfReady(`${e.toolName} started`);
			break;
		}
		case "tool_execution_update": {
			const index = findToolIndex(e.toolCallId);
			if (index >= 0) {
				// Running-tool partial text: coalesced by toolCallId into the
				// rAF flush (last partial wins, since tool output is replaced, not
				// appended). tool_execution_end drains this key first.
				pendingToolUpdates.set(e.toolCallId, {
					output: tabsToSpaces(extractText(e.partialResult)),
					images: scanImages(e.partialResult),
				});
				scheduleFlush();
			}
			break;
		}
		case "tool_execution_end": {
			const index = findToolIndex(e.toolCallId);
			if (index >= 0) {
				// Synchronous transition: a buffered partial lands first so the
				// authoritative final result replaces ALL partial text. A late
				// flush must never clobber the settled output.
				drainToolUpdate(e.toolCallId, index);
				setState(
					"items",
					produce((items) => {
						const item = items[index];
						if (item?.kind === "tool") {
							item.status = e.isError ? "error" : "done";
							item.output = capTail(tabsToSpaces(extractText(e.result)), 8000);
							const images = scanImages(e.result);
							if (images.length > 0) item.images = images;
							const details =
								e.result && typeof e.result === "object" && "details" in e.result
									? e.result.details
									: undefined;
							if (details !== undefined) item.details = details;
						}
					}),
				);
			}
			// finding #P1: announce the settled rung (failed/complete), never
			// the tool output itself.
			announceIfReady(`${e.toolName} ${e.isError ? "failed" : "completed"}`);
			break;
		}
		case "notice":
			// `command` tags a forwarded command's reply (CMD-09); the SDK notice type lacks it.
			pushItem({
				kind: "notice",
				id: nextId++,
				level: e.level,
				message: e.message,
				command: "command" in e && typeof e.command === "string" ? e.command : undefined,
			});
			if (e.level === "error") {
				// finding #P1: an error notice firing is a status message.
				announceIfReady(e.message);
			}
			break;
		case "thinking_level_changed":
			setState("thinkingLevel", e.thinkingLevel ?? undefined);
			break;
		case "goal_updated": {
			// The event carries the full GoalModeState when available; fall back
			// to deriving a minimal active state from the goal payload.
			const next = applyGoalUpdated(e);
			setState("goalModeState", next.goalModeState);
			break;
		}
		case "auto_retry_start":
			// Phase 9: live countdown badge in the session config bar; notice stays.
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
 * Cross-component prompt insertion inbox: QueueBar dequeue and HistorySearch
 * picks publish here; PromptBox consumes and clears (it owns the textarea).
 */
export const [promptInsert, setPromptInsert] = createSignal<PromptInsert | null>(null);

/**
 * Composer focus inbox: a started session publishes here; PromptComposer
 * consumes and clears (it owns the textarea).
 */
export const [promptFocusRequest, setPromptFocusRequest] = createSignal(false);

/** Start a fresh session (/new, New session button, picker gate) and focus the composer once it lands. */
export function startNewSession(): Promise<void> {
	if (!collabLive(state.collabStatus)) return startNewSessionNow();
	requestDangerConfirm({
		title: "End the live share?",
		body: "Starting a new session ends the shared room. Connected guests are disconnected.",
		confirmLabel: "End share and start new",
		onConfirm: () => {
			void startNewSessionNow();
		},
	});
	return Promise.resolve();
}

function startNewSessionNow(): Promise<void> {
	return call("newSession").then(() => {
		setPromptFocusRequest(true);
	});
}

/** Prompt insert for a restored queued message: text files come back as chips, not inlined `<file>` blocks. */
function restoredInsert(msg: { text: string; images?: ImageArg[] }): PromptInsert {
	const { text, files } = splitTextAttachments(msg.text);
	return {
		text,
		...(msg.images && msg.images.length > 0 ? { images: msg.images } : {}),
		...(files.length > 0 ? { files } : {}),
	};
}

/** Pop the last queued message back into the prompt (Alt+↑). Chips use `deleteQueuedMessage` instead. */
export function dequeueLastQueued(): void {
	void call("popLastQueuedMessage")
		.then((restored) => {
			const msg = restored as { text: string; images?: ImageArg[] } | undefined;
			if (msg) setPromptInsert(restoredInsert(msg));
		})
		.catch(reportError);
}

/** Stop the turn (Esc, Stop button) and its running subagents. Queued
 *  messages pause for Resume queue. */
export function stopTurn(): Promise<void> {
	return call("abort")
		.then(() => undefined)
		.catch(reportError);
}

/** Send the messages a Stop paused, in their original order. */
export function resumeQueuedMessages(): Promise<void> {
	return call("resumeQueue")
		.then(() => undefined)
		.catch(reportError);
}

/** Remove one queue chip by identity and reload its text into the composer. */
export function editQueuedMessage(ref: QueuedMessageRef): Promise<void> {
	return call("takeQueued", [ref])
		.then((restored) => {
			const msg = restored as { text: string; images?: ImageArg[] } | undefined;
			if (msg) setPromptInsert(restoredInsert(msg));
		})
		.catch(reportError);
}

/** Remove one queue chip by identity. */
export function deleteQueuedMessage(ref: QueuedMessageRef): Promise<void> {
	return call("takeQueued", [ref])
		.then(() => undefined)
		.catch(reportError);
}

/** Send one queue chip now: a live follow-up is promoted to steer, anything else interrupts the turn. */
export function runQueuedMessageNow(ref: QueuedMessageRef): Promise<void> {
	return call("runQueuedNow", [ref])
		.then(() => undefined)
		.catch(reportError);
}

/** Remove one queued slash command (matched by index and text) without running it. */
export function deleteQueuedCommand(ref: QueuedCommandRef): Promise<void> {
	return call("takeQueuedCommand", [ref])
		.then(() => undefined)
		.catch(reportError);
}

/** Run one queued slash command now; it runs even while Stop has paused the queue. */
export function runQueuedCommandNow(ref: QueuedCommandRef): Promise<void> {
	return call("runQueuedCommandNow", [ref])
		.then(() => undefined)
		.catch(reportError);
}
