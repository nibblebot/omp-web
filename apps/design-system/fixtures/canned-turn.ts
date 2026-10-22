import type { AssistantMessage, ToolCall, UserMessage } from "@oh-my-pi/pi-ai";
import type { WireAssistantMessageEvent, WireSessionEvent } from "#lib/wire/protocol";
import { claude } from "./screen";

/**
 * The App view's one canned agent turn, as the SDK event stream a daemon
 * sends for a prompt: the user message, a first assistant message (thinking,
 * a short note, two tool calls), both tool executions, then a second
 * assistant message with the markdown answer. Every prompt in every session
 * replays it; only the echoed prompt and the ids/timestamps differ.
 */

/** One event and when it fires, in ms after the prompt is accepted. */
export interface CannedStep {
	at: number;
	event: WireSessionEvent;
}

/** Delay between streamed text chunks; three words every 60ms reads like a live model. */
const CHUNK_MS = 60;
const WORDS_PER_CHUNK = 3;

const ANSWER = [
	"Here's where things stand.",
	"",
	"**Working tree**",
	"",
	"- `README.md` has uncommitted edits.",
	"- `notes/scratch.md` is untracked; it looks like scratch notes, so I left it alone.",
	"",
	"**Open markers**",
	"",
	"| File | Line | Note |",
	"|---|---|---|",
	"| `README.md` | 42 | document the release steps |",
	"| `CHANGELOG.md` | 3 | date for the Unreleased section |",
	"",
	"Nothing here blocks the request. A good first step is to look at the pending README edit:",
	"",
	"```sh",
	"git diff README.md",
	"```",
	"",
	"Want me to go ahead with the change, or review that edit first?",
].join("\n");

const STATUS_OUTPUT = [
	" M README.md",
	"?? notes/scratch.md",
	"a41c9e2 Tidy the release checklist",
	"7f03b18 Pin the toolchain versions",
	"c2e5d70 Add a smoke test for the CLI entrypoint",
].join("\n");

const GREP_OUTPUT = [
	"README.md:42:<!-- TODO: document the release steps -->",
	"CHANGELOG.md:3:## Unreleased (TODO: date)",
].join("\n");

/** Splits text into word-group chunks that concatenate back to the original. */
function chunks(text: string): string[] {
	const words = text.split(/(?<=\s)/);
	const out: string[] = [];
	for (let i = 0; i < words.length; i += WORDS_PER_CHUNK) {
		out.push(words.slice(i, i + WORDS_PER_CHUNK).join(""));
	}
	return out;
}

/** Usage for one assistant message, priced with the session model like the SDK does. */
function usage(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	reasoningTokens?: number,
): AssistantMessage["usage"] {
	const price = (tokens: number, perMillion: number): number => (tokens * perMillion) / 1_000_000;
	const cost = {
		input: price(input, claude.cost.input),
		output: price(output, claude.cost.output),
		cacheRead: price(cacheRead, claude.cost.cacheRead),
		cacheWrite: price(cacheWrite, claude.cost.cacheWrite),
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		cost,
	};
}

/**
 * Builds the timeline for one prompt. `run` keeps tool call ids unique across
 * replays; `now` stamps message timestamps.
 */
export function cannedTurn(prompt: string, run: number, now: number): CannedStep[] {
	const steps: CannedStep[] = [];
	let at = 0;
	const emit = (event: WireSessionEvent, delay = 0): void => {
		at += delay;
		steps.push({ at, event });
	};
	const header = {
		role: "assistant" as const,
		api: claude.api,
		provider: claude.provider,
		model: claude.id,
	};

	/** Streams one assistant message: start, per-block deltas, then the settled message. */
	const streamMessage = (message: AssistantMessage, ttft: number): void => {
		const partial: AssistantMessage = { ...message, content: [] };
		const update = (assistantMessageEvent: WireAssistantMessageEvent, delay: number): void =>
			emit({ type: "message_update", assistantMessageEvent }, delay);
		emit({ type: "message_start", message: partial }, 120);
		let delay = ttft;
		message.content.forEach((block, contentIndex) => {
			if (block.type === "thinking" || block.type === "text") {
				const kind = block.type;
				const body = kind === "thinking" ? block.thinking : block.text;
				update({ type: `${kind}_start`, contentIndex }, delay);
				for (const delta of chunks(body))
					update({ type: `${kind}_delta`, contentIndex, delta }, CHUNK_MS);
				update({ type: `${kind}_end`, contentIndex }, CHUNK_MS);
			} else if (block.type === "toolCall") {
				update({ type: "toolcall_start", contentIndex }, delay);
				update({ type: "toolcall_end", contentIndex }, 180);
			}
			delay = CHUNK_MS;
		});
		emit({ type: "message_end", message }, CHUNK_MS);
	};

	/** Runs one tool: start, a partial update with the first output line, then the result. */
	const runTool = (call: ToolCall, output: string, ms: number): void => {
		const result = { content: [{ type: "text" as const, text: output }] };
		const firstLine = output.split("\n")[0];
		const ids = { toolCallId: call.id, toolName: call.name };
		emit({ type: "tool_execution_start", ...ids, args: call.arguments }, 60);
		emit({ type: "tool_execution_update", ...ids, output: firstLine }, ms / 2);
		emit({ type: "tool_execution_end", ...ids, result }, ms / 2);
	};

	const user: UserMessage = { role: "user", content: prompt, timestamp: now };
	emit({ type: "agent_start" });
	emit({ type: "message_start", message: user });
	emit({ type: "message_end", message: user });

	// Turn 1: think, say what happens next, call two tools.
	const statusCall: ToolCall = {
		type: "toolCall",
		id: `call_canned_${run}_status`,
		name: "bash",
		arguments: { command: "git status --short && git log --oneline -3" },
	};
	const grepCall: ToolCall = {
		type: "toolCall",
		id: `call_canned_${run}_markers`,
		name: "grep",
		arguments: { pattern: "TODO|FIXME", path: "." },
	};
	const first: AssistantMessage = {
		...header,
		content: [
			{
				type: "thinking",
				thinking: `The request is: "${prompt}". Before changing anything I want the state of the working tree and any open TODO markers, so the answer is grounded in what is checked out rather than a guess.`,
			},
			{ type: "text", text: "I'll check the working tree and look for open markers first." },
			statusCall,
			grepCall,
		],
		usage: usage(2_140, 286, 18_400, 1_210, 142),
		stopReason: "toolUse",
		timestamp: now,
		ttft: 820,
		duration: 3_900,
	};
	emit({ type: "turn_start" });
	streamMessage(first, 820);
	runTool(statusCall, STATUS_OUTPUT, 640);
	runTool(grepCall, GREP_OUTPUT, 280);
	emit({ type: "turn_end" });

	// Turn 2: the markdown answer.
	const second: AssistantMessage = {
		...header,
		content: [{ type: "text", text: ANSWER }],
		usage: usage(640, 312, 21_750, 0),
		stopReason: "stop",
		timestamp: now + at,
		ttft: 640,
		duration: 4_100,
	};
	emit({ type: "turn_start" }, 300);
	streamMessage(second, 640);
	emit({ type: "turn_end" });
	emit({ type: "agent_end", lastAssistant: { stopReason: second.stopReason }, yielded: true }, 60);
	return steps;
}
