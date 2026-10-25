import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { WireSessionEvent } from "#lib/wire/protocol";
import { applyEvent, setState, state } from "../web/state";
import { jobCalls } from "./fixtures/jobs";
import { answerCalls } from "./session";
import { type CannedStep, cannedTurn } from "./fixtures/canned-turn";

/**
 * Plays the canned agent turn (fixtures/canned-turn.ts) for the App view.
 * `prompt`, `steer` and `followUp` calls are answered in the page; each
 * accepted prompt replays the turn through the real `applyEvent` action, the
 * same path the socket mux uses for `event` frames. Prompts sent while a turn
 * runs wait their turn. A state-frame-like stats update follows every
 * settled message, so the cost, token and context readouts move.
 */

interface Run {
	workspaceId: string;
	timers: number[];
	/** Tool calls started and not yet ended, for abort. */
	openTools: Map<string, string>;
	/** The assistant message being streamed, rebuilt from its deltas, for abort. */
	streaming: AssistantMessage | null;
}

let active: Run | null = null;
const queued: string[] = [];
let runCount = 0;

/** Answer the prompt-family and abort calls; call after `applySeeds` (it resets session handlers). */
export function answerCannedTurns(): void {
	const accept = (args: unknown[]): undefined => {
		const text = typeof args[0] === "string" ? args[0] : "";
		if (active === null) start(text);
		else queued.push(text);
		return undefined;
	};
	answerCalls({
		...jobCalls(),
		prompt: accept,
		steer: accept,
		followUp: accept,
		abort: () => {
			queued.length = 0;
			abortCannedTurn();
			return undefined;
		},
	});
}

/**
 * Stop the running turn the way an abort does: the half-streamed assistant
 * message settles as aborted, running tools end in error, the agent ends.
 * Synchronous, so a session switch can settle the transcript before saving it.
 */
export function abortCannedTurn(): void {
	const run = active;
	if (run === null) return;
	active = null;
	queued.length = 0;
	for (const timer of run.timers) clearTimeout(timer);
	if (run.streaming !== null) {
		applyEvent({ type: "message_end", message: { ...run.streaming, stopReason: "aborted" } });
	}
	for (const [toolCallId, toolName] of run.openTools) {
		applyEvent({
			type: "tool_execution_end",
			toolCallId,
			toolName,
			result: { content: [{ type: "text", text: "Aborted" }] },
			isError: true,
		});
	}
	applyEvent({ type: "agent_end", yielded: true });
}

function start(prompt: string): void {
	const run: Run = {
		workspaceId: state.currentWorkspaceId,
		timers: [],
		openTools: new Map(),
		streaming: null,
	};
	active = run;
	runCount += 1;
	const steps = cannedTurn(prompt, runCount, Date.now());
	run.timers = steps.map((step) => window.setTimeout(() => play(run, step), step.at));
}

function play(run: Run, step: CannedStep): void {
	// A session switch aborts the run synchronously (app-view.tsx), so a stale
	// timer only ever finds a superseded run here.
	if (active !== run) return;
	track(run, step.event);
	applyEvent(step.event);
	if (step.event.type === "message_end") settleStats(step.event.message);
	if (step.event.type === "agent_end") {
		active = null;
		const next = queued.shift();
		if (next !== undefined) start(next);
	}
}

/** Keep what abort needs: open tools and the streamed assistant content so far. */
function track(run: Run, event: WireSessionEvent): void {
	switch (event.type) {
		case "tool_execution_start":
			run.openTools.set(event.toolCallId, event.toolName);
			break;
		case "tool_execution_end":
			run.openTools.delete(event.toolCallId);
			break;
		case "message_start":
			if (event.message.role === "assistant") run.streaming = { ...event.message, content: [] };
			break;
		case "message_end":
			if (event.message.role === "assistant") run.streaming = null;
			break;
		case "message_update": {
			const message = run.streaming;
			const ev = event.assistantMessageEvent;
			if (message === null) break;
			if (ev.type === "thinking_start")
				message.content[ev.contentIndex] = { type: "thinking", thinking: "" };
			else if (ev.type === "text_start")
				message.content[ev.contentIndex] = { type: "text", text: "" };
			else if (ev.type === "thinking_delta" || ev.type === "text_delta") {
				const block = message.content[ev.contentIndex];
				if (block?.type === "thinking") block.thinking += ev.delta;
				else if (block?.type === "text") block.text += ev.delta;
			}
			break;
		}
		default:
			break;
	}
}

/** What a session's `state` frame would carry after a settled message: counts, tokens, cost, context. */
function settleStats(message: AgentMessage): void {
	setState("messageCount", (n) => n + 1);
	const stats = state.stats;
	if (stats === null) return;
	const role = message.role;
	const usage = role === "assistant" ? message.usage : undefined;
	setState("stats", {
		...stats,
		userMessages: stats.userMessages + (role === "user" ? 1 : 0),
		assistantMessages: stats.assistantMessages + (role === "assistant" ? 1 : 0),
		toolResults: stats.toolResults + (role === "toolResult" ? 1 : 0),
		toolCalls:
			stats.toolCalls +
			(role === "assistant" ? message.content.filter((c) => c.type === "toolCall").length : 0),
		totalMessages: stats.totalMessages + 1,
		tokens:
			usage === undefined
				? stats.tokens
				: {
						input: stats.tokens.input + usage.input,
						output: stats.tokens.output + usage.output,
						reasoning: stats.tokens.reasoning + (usage.reasoningTokens ?? 0),
						cacheRead: stats.tokens.cacheRead + usage.cacheRead,
						cacheWrite: stats.tokens.cacheWrite + usage.cacheWrite,
						total: stats.tokens.total + usage.totalTokens,
					},
		cost: stats.cost + (usage?.cost.total ?? 0),
	});
	// The context grows by what this message added: its fresh input and its output.
	const context = state.contextUsage;
	if (usage !== undefined && context !== undefined) {
		const tokens = Math.min(context.contextWindow, context.tokens + usage.input + usage.output);
		setState("contextUsage", {
			tokens,
			contextWindow: context.contextWindow,
			percent: Math.round((tokens / context.contextWindow) * 1000) / 10,
		});
	}
}
