import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { createStore, produce } from "solid-js/store";
import type { ClientCommand, ServerFrame } from "./protocol";

export type Block = { kind: "text" | "thinking"; text: string };
export type ToolStatus = "running" | "done" | "error";
export type ChatItem =
	| { kind: "user"; id: number; text: string }
	| { kind: "assistant"; id: number; blocks: Block[] }
	| { kind: "tool"; id: number; toolCallId: string; name: string; args: string; status: ToolStatus; output: string }
	| { kind: "notice"; id: number; level: string; message: string };

export const [state, setState] = createStore({
	items: [] as ChatItem[],
	live: { active: false, blocks: [] as Block[] },
	streaming: false,
	model: "",
	thinking: undefined as string | undefined,
	error: null as string | null,
	// Display toggles (StatusBar checkboxes); both default off = raw streaming.
	reveal: false,
	soften: false,
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
				args: (s => (s.length > 500 ? s.slice(0, 500) : s))(tabsToSpaces(JSON.stringify(e.args ?? null) ?? "")),
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
			setState("thinking", e.thinkingLevel ? String(e.thinkingLevel) : undefined);
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
		default:
			// turn_start/turn_end, auto_*_end, retry_fallback_*, ttsr_triggered,
			// todo_*, irc_message, goal_updated: ignored.
			break;
	}
}

export function loadHistory(messages: AgentMessage[]): void {
	pendingDeltas.clear();
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
						args: (s => (s.length > 500 ? s.slice(0, 500) : s))(tabsToSpaces(JSON.stringify(c.arguments ?? {}))),
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
				pushItem({ kind: "tool", id: nextId++, toolCallId: msg.toolCallId, name: msg.toolName, args: "", status, output });
			}
		}
		// Any other role (developer, custom messages): skip.
	}
}

function applyState(s: RpcSessionState): void {
	setState("model", s.model ? `${s.model.provider}/${s.model.id}` : "");
	setState("thinking", s.thinkingLevel ? String(s.thinkingLevel) : undefined);
	setState("streaming", s.isStreaming);
}

let ws: WebSocket | null = null;

export function connect(): void {
	const socket = new WebSocket(`ws://${location.host}/ws`);
	ws = socket;
	socket.onmessage = ev => {
		const frame = JSON.parse(String(ev.data)) as ServerFrame;
		switch (frame.type) {
			case "history":
				loadHistory(frame.messages);
				break;
			case "state":
				applyState(frame.state);
				break;
			case "event":
				applyEvent(frame.event);
				break;
			case "error":
				setState("error", frame.error);
				break;
		}
	};
	socket.onclose = () => {
		if (ws === socket) setTimeout(connect, 1000);
	};
}

export function send(cmd: ClientCommand): void {
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
}
