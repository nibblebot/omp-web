/**
 * Streaming assistant updates cross the wire as deltas keyed by content block.
 * The SDK's message_update carries the cumulative message twice, so shipping it
 * verbatim made a reply cost O(n^2) bytes on every hop (client replay ring, control
 * mirror, each browser stream).
 */
import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { SessionEntry } from "../session-entry";
import { streamingPrimeFrames, toWireEvent, trackStreamingAssistant } from "../client-delivery";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** The SDK's event for one text token: both the message and the partial hold the whole text so far. */
function textDelta(soFar: string, delta: string): AgentSessionEvent {
	const partial = assistant(soFar);
	return {
		type: "message_update",
		message: partial,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
	};
}

describe("toWireEvent", () => {
	test("a text delta keeps only its block index and the appended text", () => {
		expect(toWireEvent("s1", textDelta("hello world", " world"))).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: " world" },
		});
	});

	test("thinking deltas are keyed the same way", () => {
		const partial = assistant("");
		const event: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "hm", partial },
		};
		expect(toWireEvent("s1", event)).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 2, delta: "hm" },
		});
	});

	test("block markers drop the snapshot, the settled content and the tool call", () => {
		const partial = assistant("x");
		const start: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_start", contentIndex: 1, partial },
		};
		const end: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "x", partial },
		};
		const done: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "done", reason: "stop", message: partial },
		};
		expect(toWireEvent("s1", start)).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 1 },
		});
		expect(toWireEvent("s1", end)).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "text_end", contentIndex: 1 },
		});
		expect(toWireEvent("s1", done)).toEqual({
			type: "message_update",
			assistantMessageEvent: { type: "done" },
		});
	});

	test("message_end keeps the full settled message", () => {
		const event: AgentSessionEvent = { type: "message_end", message: assistant("final text") };
		expect(toWireEvent("s1", event)).toBe(event);
	});

	test("bytes per reply grow linearly, not quadratically", () => {
		const tokens = 2000;
		let soFar = "";
		let wireBytes = 0;
		let lastFrameBytes = 0;
		let verbatimBytes = 0;
		for (let i = 0; i < tokens; i++) {
			const delta = `tok${i} `;
			soFar += delta;
			const event = textDelta(soFar, delta);
			lastFrameBytes = JSON.stringify(toWireEvent("s1", event)).length;
			wireBytes += lastFrameBytes;
			verbatimBytes += JSON.stringify(event).length;
		}
		// Constant-size frames: the last one is no bigger than a token plus envelope.
		expect(lastFrameBytes).toBeLessThan(120);
		expect(wireBytes).toBeLessThan(tokens * 120);
		// The cumulative shape was hundreds of times larger for the same reply.
		expect(verbatimBytes / wireBytes).toBeGreaterThan(100);
	});
});

describe("streamingPrimeFrames", () => {
	test("a late joiner is primed with the in-progress message, not one frame per token", () => {
		const entry = { handle: "s1" } as SessionEntry;
		expect(streamingPrimeFrames(entry)).toEqual([]);
		trackStreamingAssistant(entry, textDelta("hello", "lo"));
		expect(streamingPrimeFrames(entry)).toEqual([
			{ type: "event", event: { type: "message_start", message: assistant("hello") } },
		]);
	});

	test("message_end clears the in-progress message", () => {
		const entry = { handle: "s1" } as SessionEntry;
		trackStreamingAssistant(entry, textDelta("", "hi"));
		trackStreamingAssistant(entry, {
			type: "message_end",
			message: assistant("hi"),
		} as AgentSessionEvent);
		expect(streamingPrimeFrames(entry)).toEqual([]);
	});
});

/** A backgrounded call: it returned (`tool_execution_end`) while its job keeps reporting frames. */
describe("backgrounded tool calls", () => {
	const job = (state: string, extra: Record<string, unknown> = {}) => ({
		...extra,
		async: { state, jobId: "bg_1", type: "bash" },
	});
	const returned = {
		type: "tool_execution_end",
		toolCallId: "c1",
		toolName: "bash",
		result: {
			content: [{ type: "text", text: "Backgrounded as job bg_1" }],
			details: job("running"),
		},
	} as unknown as AgentSessionEvent;
	const frame = (text: string, details: unknown) =>
		({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text }], details },
		}) as unknown as AgentSessionEvent;

	test("frames after tool_execution_end reach the browsers with the job's state", () => {
		const handle = "bg-forward";
		toWireEvent(handle, returned);
		expect(toWireEvent(handle, frame("line 1\n", job("running")))).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "line 1\n",
			async: { state: "running" },
		});
		// Same state, more output: only the appended text rides.
		expect(toWireEvent(handle, frame("line 1\nline 2\n", job("running")))).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "line 2\n",
			append: true,
		});
		// The job's last frame names its state and the exit code of a failed command.
		expect(toWireEvent(handle, frame("boom", job("failed", { exitCode: 2 })))).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "boom",
			async: { state: "failed", exitCode: 2 },
		});
	});

	test("a new state alone is news, an empty append", () => {
		const handle = "bg-state-only";
		toWireEvent(handle, returned);
		toWireEvent(handle, frame("same", job("running")));
		expect(toWireEvent(handle, frame("same", job("completed")))).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "",
			append: true,
			async: { state: "completed" },
		});
	});

	test("an unchanged frame sends nothing", () => {
		const handle = "bg-quiet";
		toWireEvent(handle, returned);
		toWireEvent(handle, frame("same", job("running")));
		expect(toWireEvent(handle, frame("same", job("running")))).toBeNull();
	});

	test("a late joiner is primed with the job's state, and a settled job leaves no priming", () => {
		const entry = { handle: "bg-prime" } as SessionEntry;
		toWireEvent(entry.handle, returned);
		toWireEvent(entry.handle, frame("so far", job("running")));
		expect(streamingPrimeFrames(entry)).toEqual([
			{
				type: "event",
				event: {
					type: "tool_execution_update",
					toolCallId: "c1",
					toolName: "bash",
					output: "so far",
					async: { state: "running" },
				},
			},
		]);
		toWireEvent(entry.handle, frame("done", job("completed")));
		expect(streamingPrimeFrames(entry)).toEqual([]);
	});

	test("a job that has shown no output yet is primed as an empty append", () => {
		const entry = { handle: "bg-prime-empty" } as SessionEntry;
		toWireEvent(entry.handle, returned);
		toWireEvent(entry.handle, frame("", job("running")));
		expect(streamingPrimeFrames(entry)).toEqual([
			{
				type: "event",
				event: {
					type: "tool_execution_update",
					toolCallId: "c1",
					toolName: "bash",
					output: "",
					append: true,
					async: { state: "running" },
				},
			},
		]);
	});

	test("a partial without a job frame carries none", () => {
		const handle = "bg-plain";
		expect(toWireEvent(handle, frame("x", {}))).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "x",
		});
	});
});
