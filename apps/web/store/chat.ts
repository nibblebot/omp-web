import { createSignal } from "solid-js";
import { produce, unwrap } from "solid-js/store";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type {
	ImageArg,
	QueuedCommandRef,
	QueuedMessageRef,
	WireSessionEvent,
	WireAsyncFrame,
	WireToolLive,
} from "#lib/wire/protocol";
import { extractText, scanImages } from "#lib/wire/tool-result";
import { promptTimestamp } from "../chat/turn-usage";
import { abortedTools, toolResultStatus } from "../chat/tool-interrupt";
import {
	applyAsyncResults,
	asyncResultJobsOf,
	backgroundOf,
	isBackgroundRunning,
	settleBackground,
	type AsyncResultJob,
} from "../chat/background-job";
import { smoothStreaming } from "../chat/display-prefs";
import type { UsageLike } from "../usage/usage";
import {
	setState,
	state,
	type BashResultLike,
	type Block,
	type ChatItem,
	type ToolItem,
	type CompactionItem,
	type PromptInsert,
} from "../state";
import { splitTextAttachments } from "../prompt/attachments";
import { isReady } from "./session";
import { call } from "./transport";
import { currentNotifyPermission } from "./notify";
import { reportError } from "./toasts";
import { advisorNotesOf } from "./slices/advisor";
import { collabLive, guestPromptOf } from "./slices/collab";
import { flushBtwEphemeral } from "./slices/btw";
import { applyGoalUpdated } from "./slices/goals";
import { settingValue } from "./settings";
import { requestDangerConfirm } from "../prompt/danger-confirm";

/**
 * Chat/streaming domain (Phase 3 store facade split). Everything that mutates
 * the transcript (`items`/`live`), the /btw side panel reply buffer, and the
 * rAF-coalesced write machinery moved here from state.ts; state.ts re-exports
 * the public actions so call sites stay byte-identical. The store itself and
 * the connect()/socket mux remain in state.ts. This module's buffered maps are
 * drained by the single flushDeltas rAF loop and called into by the mux.
 */

/** localStorage key for the browser-notifications toggle. */
const NOTIFY_KEY = "omp.notifyEnabled";

let nextId = 1;

/** Reset the transcript id sequence (history rebuild / session switch). */
export function resetChatIds(): void {
	nextId = 1;
}

/**
 * A turn that is not streaming has no tool in flight. A replayed transcript
 * opens an unanswered tool call as running (its result is written only when the
 * tool returns), so an idle snapshot settles any such leftover here. The call
 * never reported an outcome, so it reads as interrupted, not done.
 */
export function settleRunningTools(): void {
	if (!state.items.some((it) => it.kind === "tool" && it.status === "running")) return;
	setState(
		"items",
		produce((items) => {
			for (const item of items) {
				if (item.kind === "tool" && item.status === "running") item.status = "interrupted";
			}
		}),
	);
}

/**
 * An aborted assistant message arrived: the tools of the closest earlier
 * assistant that made calls were cut short, so those still running or settled
 * `error` (what Esc turns a killed tool into) become interrupted. Mutates in place.
 */
function interruptAbortedTools(): void {
	const targets = abortedTools(state.items);
	if (targets.length === 0) return;
	const ids = new Set(targets.map((item) => item.id));
	setState(
		"items",
		produce((items) => {
			for (const item of items) {
				if (item.kind === "tool" && ids.has(item.id)) item.status = "interrupted";
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

/**
 * The last `max` characters of `s`. A cut tail is copied into its own flat string: `slice` returns a view
 * that keeps its whole parent alive, so a bare slice would pin the full multi-MB tool output the cap exists
 * to drop. The concatenation forces a fresh flat buffer; the final `slice(1)` is a view over that small copy.
 */
export function capTail(s: string, max: number): string {
	return s.length > max ? (" " + s.slice(-max)).slice(1) : s;
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

/** Ctrl+O: expand or collapse every tool card at once. */
export function toggleToolsExpanded(): void {
	setState("toolsExpanded", (v) => !v);
}

/** Re-read the browser's notification permission into the store (it changes in site settings, outside the page). */
export function refreshNotifyPermission(): void {
	setState("notifyPermission", currentNotifyPermission());
}

/**
 * Persisted browser-notifications toggle. Turning it on asks the browser
 * when permission is still undecided and stays on only once permission is
 * granted; a dismissed or denied prompt leaves it off. Off is always allowed.
 */
export async function setNotifyEnabled(enabled: boolean): Promise<void> {
	if (enabled && currentNotifyPermission() === "default") {
		// Resolves "default" when the prompt is dismissed; can reject outside a secure context.
		await Notification.requestPermission().catch(() => undefined);
	}
	refreshNotifyPermission();
	const on = enabled && state.notifyPermission === "granted";
	if (typeof localStorage !== "undefined") localStorage.setItem(NOTIFY_KEY, String(on));
	setState("notifyEnabled", on);
}

/**
 * Append in place: the list keeps its identity, so only the new item is wrapped and the
 * `<For>` over it keeps its mapper closures (a copied array per push is O(n) work and,
 * through those closures, O(n^2) retained heap).
 */
export function pushItem(item: ChatItem): void {
	setState("items", state.items.length, item);
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

/**
 * Index of the first item `match` accepts, -1 for none. Scans the raw list: the same
 * walk through the store's proxy wraps every item it passes and costs an order of
 * magnitude more per streamed frame on a long transcript.
 */
function indexWhere(match: (item: ChatItem) => boolean): number {
	return unwrap(state.items).findIndex(match);
}

export function findToolIndex(toolCallId: string): number {
	return indexWhere((it) => it.kind === "tool" && it.toolCallId === toolCallId);
}

const bashIndex = (id: number): number => indexWhere((it) => it.kind === "bash" && it.id === id);

/** Live chunk from the server relay: append to the in-flight item's output. */
export function appendBashChunk(id: number, text: string): void {
	if (!text) return;
	const index = bashIndex(id);
	if (index < 0) return;
	// Buffered into the rAF flush and coalesced by item id: N chunks between
	// flushes = 1 store write (≤60/s cap preserved). resolveBashItem drains
	// this key first so the authoritative result never interleaves with
	// streamed text. rAF does not fire in a hidden tab while chunks keep
	// arriving, so the buffer is trimmed here (amortized: only once it holds
	// twice what the flush keeps) instead of growing until the tab is shown.
	const pending = pendingBashChunks.get(id);
	const buffered = pending === undefined ? text : pending + text;
	pendingBashChunks.set(id, buffered.length > 16000 ? capTail(buffered, 8000) : buffered);
	scheduleFlush();
}

export function resolveBashItem(id: number, result: BashResultLike | { error: string }): void {
	const index = bashIndex(id);
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

// Token deltas are buffered and applied at most once per animation frame,
// capping store writes at ≤60/s regardless of provider chunk rate.
const pendingDeltas = new Map<number, { kind: Block["kind"]; text: string }>();

/** Drop all buffered token deltas (history rebuild / session reset). */
export function clearPendingDeltas(): void {
	pendingDeltas.clear();
	pendingToolUpdates.clear();
	earlyJobFrames.clear();
}

/**
 * A job's last frame (and the output the card showed with it) that arrived while its call
 * had not yet returned. The buffered partial may flush before the end event, so the frame
 * is kept here until `tool_execution_end` decides whether the call parks on that job.
 */
const earlyJobFrames = new Map<string, { job: WireAsyncFrame; output: string }>();

// Phase 1: Socket-frame text writes share the same rAF flush, coalescing N
// frames between flushes into 1 store write per target key. Keys are stable
// ids (toolCallId / bash item id / btw streamId). Unlike pendingDeltas'
// positional block indices, a flush can never apply to the wrong item.
// ONLY text/chunk appends and running-status text updates are buffered here;
// state transitions (tool_execution_end, resolveBashItem, call_result, stream
// close) stay synchronous and drain the matching key first so output is never
// lost or reordered. A tool partial either REPLACES the card's output (a
// snapshot) or APPENDS to it (`append` frames); a snapshot buffered before an
// append keeps the pair a snapshot. Bash/python chunks and btw deltas APPEND
// (frames coalesce).
const pendingToolUpdates = new Map<string, PendingToolUpdate>();
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

	// Coalesced Socket-frame writes: at most one store write per target key per
	// flush (the rAF cadence caps this at ≤60/s). The maps touch disjoint
	// store paths (items vs btw.reply vs live.blocks), so application order
	// between them is unconstrained.
	if (pendingToolUpdates.size > 0) {
		setState(
			"items",
			produce((items) => {
				for (const [toolCallId, update] of pendingToolUpdates) {
					const item = items[findToolIndex(toolCallId)];
					if (item?.kind !== "tool" || !(item.status === "running" || isBackgroundRunning(item)))
						continue;
					applyToolUpdate(item, update);
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
					const item = items[bashIndex(id)];
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
	for (const [index, d] of pendingDeltas) {
		if (budget <= 0) break;
		const cut = budget >= d.text.length ? d.text.length : codePointCut(d.text, budget);
		if (state.live.blocks[index]?.kind !== d.kind) ensureLiveBlock(index, d.kind);
		// In-place path mutation keeps block identity stable, so <For> does not
		// recreate StreamingBlock components on every frame.
		setState("live", "blocks", index, "text", (text) => text + tabsToSpaces(d.text.slice(0, cut)));
		if (cut >= d.text.length) pendingDeltas.delete(index);
		else d.text = d.text.slice(cut);
		budget -= cut;
	}
	if (pendingDeltas.size > 0) scheduleFlush();
}

function sameImages(a: ImageArg[] | undefined, b: ImageArg[]): boolean {
	return (
		a !== undefined &&
		a.length === b.length &&
		a.every((img, i) => img.data === b[i]!.data && img.mimeType === b[i]!.mimeType)
	);
}

/** A buffered tool partial: what the card shows next. */
interface PendingToolUpdate {
	output: string;
	append: boolean;
	images: ImageArg[] | undefined;
	live: WireToolLive | undefined;
	/** The job frame of a call that returned while its job runs; the newest one wins. */
	job: WireAsyncFrame | undefined;
	/** The call's `out://` replies so far; the newest list wins. */
	replies: string[] | undefined;
}

/**
 * Apply a buffered tool partial to its card: replace the output, or append to it. A
 * job frame also settles the card parked on that job.
 */
function applyToolUpdate(item: ToolItem, update: PendingToolUpdate): void {
	item.output = capTail(update.append ? item.output + update.output : update.output, 8000);
	// Every frame carries its images as fresh objects: an unchanged set keeps the card's own, so its
	// thumbnails neither re-render nor re-resolve their URLs on each flush.
	if (update.images !== undefined && !sameImages(item.images, update.images))
		item.images = update.images;
	if (update.live !== undefined) item.live = { ...update.live, at: Date.now() };
	if (update.replies !== undefined) item.replies = update.replies;
	const job = update.job;
	if (job !== undefined && job.state !== "running" && item.background !== undefined) {
		settleBackground(item, {
			state: job.state,
			...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
			durationMs: Math.max(0, Date.now() - item.background.startedAt),
		});
	}
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
			applyToolUpdate(item, update);
		}),
	);
}

/**
 * Apply every buffered frame of the cards parked on a background job now, so a card
 * about to settle keeps the job's last output instead of losing it to the next flush.
 */
export function drainParkedToolUpdates(): void {
	state.items.forEach((item, index) => {
		if (item.kind === "tool" && isBackgroundRunning(item)) drainToolUpdate(item.toolCallId, index);
	});
}

/**
 * An `async-result` delivery reports background jobs settled: finish the cards parked
 * on them. The card's own frames normally did already; this settles one that missed
 * them (a reload, a dropped frame). A buffered frame lands first, so the job's last
 * output wins over the text the call returned with.
 */
function settleDeliveredJobs(jobs: readonly AsyncResultJob[]): void {
	drainParkedToolUpdates();
	setState(
		"items",
		produce((items) => {
			applyAsyncResults(
				items.filter((item): item is ToolItem => item.kind === "tool"),
				jobs,
			);
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
		// Content that never shows (a tool call) can sit before this index; fill its
		// slot so the array stays dense for the live render.
		for (let i = next.length; i < contentIndex; i++) next[i] = emptyLiveBlock();
		next[contentIndex] = { kind, text: next[contentIndex]?.text ?? "" };
		return next;
	});
}

/**
 * One assistant content block as the transcript shows it. A thinking block the
 * provider flagged `narration` (prose addressed to the user between tool calls)
 * is answer text, matching the TUI's `presentNarrationAsAnswer`. Display-only:
 * the SDK keeps the thinking block and its signature for replay; the web never
 * sends content back. The flag lands with the block's signature at block end,
 * after the slim stream frames, so a live block streams as thinking and flips
 * here, at `message_end` (or when a late joiner is primed past that block).
 */
function displayBlock(c: AssistantContent[number]): Block | undefined {
	if (c.type === "text") return { kind: "text", text: tabsToSpaces(c.text) };
	if (c.type === "thinking")
		return { kind: c.narration === true ? "text" : "thinking", text: tabsToSpaces(c.thinking) };
	return undefined;
}

export function assistantBlocks(content: AssistantContent): Block[] {
	const blocks: Block[] = [];
	for (const c of content) {
		const block = displayBlock(c);
		if (block !== undefined) blocks.push(block);
	}
	return blocks;
}

/** The slot of live content that shows nothing, such as a tool call between text blocks. */
function emptyLiveBlock(): Block {
	return { kind: "text", text: "" };
}

/** Live blocks for a message seeded mid-stream, keyed by contentIndex (deltas address blocks by index); dense, with an empty block where the content shows nothing. */
function liveBlocks(content: AssistantContent): Block[] {
	return content.map((c) => displayBlock(c) ?? emptyLiveBlock());
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

export function applyEvent(e: WireSessionEvent): void {
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
			// finding #P1: turn ended (streamed text itself is never announced).
			announceIfReady("agent finished");
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
				setState("live", { active: true, blocks: liveBlocks(msg.content) });
			}
			break;
		}
		case "message_update": {
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
				if (meta.stopReason === "aborted") interruptAbortedTools();
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
				// A background job settled after its call returned: finish the cards parked on it.
				const delivered = asyncResultJobsOf(msg);
				if (delivered.length > 0) settleDeliveredJobs(delivered);
				// Advisor cards (steered or preserved) settle as custom messages.
				const notes = advisorNotesOf(msg);
				if (notes !== null) pushItem({ kind: "advisor", id: nextId++, notes });
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
				// rAF flush. A snapshot replaces what is buffered; an append
				// extends it (only the tail the card keeps is buffered).
				// tool_execution_end drains this key first.
				const output = tabsToSpaces(e.output);
				const images = e.images !== undefined && e.images.length > 0 ? e.images : undefined;
				const pending = pendingToolUpdates.get(e.toolCallId);
				const job = e.async ?? pending?.job;
				if (e.async?.state === "cancelled") {
					// A cancelled job's last frame is the cancellation text, not output: the card keeps
					// the output it got to, buffered chunks included.
					if (pending !== undefined) {
						pending.job = job;
						if (e.replies !== undefined) pending.replies = e.replies;
					} else
						pendingToolUpdates.set(e.toolCallId, {
							output: "",
							append: true,
							images: undefined,
							live: e.live,
							job,
							replies: e.replies,
						});
				} else if (e.append === true && pending !== undefined) {
					pending.output = capTail(pending.output + output, 8000);
					if (images !== undefined) pending.images = images;
					if (e.live !== undefined) pending.live = e.live;
					if (e.replies !== undefined) pending.replies = e.replies;
					pending.job = job;
				} else {
					pendingToolUpdates.set(e.toolCallId, {
						output,
						append: e.append === true,
						images: images ?? pending?.images,
						live: e.live ?? pending?.live,
						job,
						replies: e.replies ?? pending?.replies,
					});
				}
				const card = state.items[index];
				if (
					e.async !== undefined &&
					e.async.state !== "running" &&
					card?.kind === "tool" &&
					card.status === "running"
				) {
					// The job ended before its call returned: what the card shows now is the job's result.
					const buffered = pendingToolUpdates.get(e.toolCallId);
					const shown =
						buffered === undefined
							? card.output
							: buffered.append
								? card.output + buffered.output
								: buffered.output;
					earlyJobFrames.set(e.toolCallId, { job: e.async, output: capTail(shown, 8000) });
				}
				scheduleFlush();
			}
			break;
		}
		case "tool_execution_end": {
			const index = findToolIndex(e.toolCallId);
			const details =
				e.result && typeof e.result === "object" && "details" in e.result
					? e.result.details
					: undefined;
			const status = toolResultStatus(e.isError, details);
			if (index >= 0) {
				// Synchronous transition: a buffered partial lands first so the
				// authoritative final result replaces ALL partial text. A late
				// flush must never clobber the settled output.
				// A job frame that beat the end event: the call's job is already over.
				const early = earlyJobFrames.get(e.toolCallId);
				earlyJobFrames.delete(e.toolCallId);
				drainToolUpdate(e.toolCallId, index);
				setState(
					"items",
					produce((items) => {
						const item = items[index];
						if (item?.kind === "tool") {
							item.status = status;
							item.output = capTail(tabsToSpaces(extractText(e.result)), 8000);
							const images = scanImages(e.result);
							if (images.length > 0) item.images = images;
							if (details !== undefined) item.details = details;
							item.live = undefined;
							// A call that returned while its job runs stays parked on the job (its later frames fill the card).
							const parked = backgroundOf(e.toolName, details, Date.now());
							if (parked !== undefined) item.background = parked;
							if (parked !== undefined && early !== undefined) {
								// The job's last frame is the call's result, as the TUI settles a parked card.
								if (early.output !== "") item.output = early.output;
								settleBackground(item, {
									state: early.job.state === "running" ? "completed" : early.job.state,
									...(early.job.exitCode !== undefined ? { exitCode: early.job.exitCode } : {}),
								});
							}
						}
					}),
				);
			}
			// finding #P1: announce the settled rung (failed/complete/interrupted),
			// never the tool output itself.
			announceIfReady(
				`${e.toolName} ${status === "interrupted" ? "interrupted" : e.isError ? "failed" : "completed"}`,
			);
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

/**
 * Whether a programmatic composer focus may take the keyboard: a fine pointer
 * (no soft keyboard popping up on touch), no modal open, and no agent question
 * (ask/permission dialog) waiting for an answer.
 */
export function mayAutoFocusComposer(): boolean {
	return (
		window.matchMedia("(pointer: fine)").matches && state.modal === null && state.uiRequest === null
	);
}

/** Start a fresh session (/new, New session button, new workspace) and focus the composer once it lands. */
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
