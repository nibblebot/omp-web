/**
 * Streaming assistant updates cross the wire as deltas keyed by content block.
 * The SDK's message_update carries the cumulative message twice, so shipping it
 * verbatim made a reply cost O(n^2) bytes on every hop (SSE ring, control
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
