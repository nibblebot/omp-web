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
import {
	broadcastHistory,
	historyFrames,
	streamingPrimeFrames,
	toWireEvent,
	trackStreamingAssistant,
} from "../client-delivery";

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

/** A bash or eval call whose commands wrote to out://: every frame of its card repeats the replies so far. */
describe("out:// replies", () => {
	const frame = (toolName: string, text: string, details: unknown) =>
		({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName,
			args: {},
			partialResult: { content: [{ type: "text", text }], details },
		}) as unknown as AgentSessionEvent;

	test("an update carries the whole list when it changed, and nothing while it did not", () => {
		const handle = "replies-forward";
		expect(toWireEvent(handle, frame("bash", "tests\n", { replies: ["one"] }))).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "tests\n",
			replies: ["one"],
		});
		// More output, same replies: the list does not ride again.
		expect(toWireEvent(handle, frame("bash", "tests\nmore\n", { replies: ["one"] }))).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "more\n",
			append: true,
		});
		// A new reply alone is an empty append with the whole list.
		expect(
			toWireEvent(handle, frame("bash", "tests\nmore\n", { replies: ["one", "two"] })),
		).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "",
			append: true,
			replies: ["one", "two"],
		});
		expect(
			toWireEvent(handle, frame("bash", "tests\nmore\n", { replies: ["one", "two"] })),
		).toBeNull();
		// A partial without replies keeps what the browsers hold.
		expect(toWireEvent(handle, frame("bash", "tests\nmore\n", {}))).toBeNull();
	});

	test("an eval cell's replies ride the same way, and blank ones are not replies", () => {
		const handle = "replies-eval";
		expect(
			toWireEvent(handle, frame("eval", "", { cells: [], replies: ["", "from a cell"] })),
		).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "eval",
			output: "",
			append: true,
			replies: ["from a cell"],
		});
		expect(toWireEvent("replies-blank", frame("bash", "", { replies: ["  "] }))).toBeNull();
	});

	test("the settled result keeps its details, replies included", () => {
		const handle = "replies-end";
		const ended = {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: { replies: ["one"] } },
		} as unknown as AgentSessionEvent;
		expect(toWireEvent(handle, ended) as unknown).toBe(ended);
	});

	test("the settled result keeps the minimizer meta, in a live frame and in a shrunk history frame", () => {
		const minimized = { filter: "git", inputBytes: 123_300, outputBytes: 3_277, artifactId: "7" };
		const ended = {
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: { meta: { minimized } } },
		} as unknown as AgentSessionEvent;
		expect(toWireEvent("minimized-end", ended) as unknown).toBe(ended);

		// A result past the history frame ceiling is clipped in place; the meta is numbers and a short label.
		const message = {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(2 * 1024 * 1024) }],
			details: { meta: { minimized } },
			isError: false,
			timestamp: 0,
		};
		const frames = historyFrames([message] as never);
		const sent = frames.flatMap((f) => f.messages)[0] as unknown as typeof message;
		expect(JSON.stringify(sent).length).toBeLessThan(1024 * 1024);
		expect(sent.details).toEqual({ meta: { minimized } });
	});

	test("a late joiner is primed with the replies, and a resync resends them", async () => {
		const entry = { handle: "replies-prime" } as SessionEntry;
		toWireEvent(entry.handle, frame("bash", "so far", { replies: ["one"] }));
		expect(streamingPrimeFrames(entry)).toEqual([
			{
				type: "event",
				event: {
					type: "tool_execution_update",
					toolCallId: "c1",
					toolName: "bash",
					output: "so far",
					replies: ["one"],
				},
			},
		]);
		await broadcastHistory(entry.handle, []);
		expect(toWireEvent(entry.handle, frame("bash", "so far", { replies: ["one"] }))).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "so far",
			replies: ["one"],
		});
	});

	test("a call that only replied is primed as an empty append", () => {
		const entry = { handle: "replies-prime-empty" } as SessionEntry;
		toWireEvent(entry.handle, frame("eval", "", { replies: ["early"] }));
		expect(streamingPrimeFrames(entry)).toEqual([
			{
				type: "event",
				event: {
					type: "tool_execution_update",
					toolCallId: "c1",
					toolName: "eval",
					output: "",
					append: true,
					replies: ["early"],
				},
			},
		]);
	});
});

/** SDK 18.17.0 puts a shell execution trace (MBs for a loop) on every bash result and partial; the web never renders it. */
describe("bash shell trace", () => {
	const trace = { id: "run", events: "t".repeat(64 * 1024) };
	const ended = (toolName: string, details: Record<string, unknown>) =>
		({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName,
			result: { content: [{ type: "text", text: "ok" }], details },
		}) as unknown as AgentSessionEvent;
	const toolResult = (toolName: string, text: string, details: Record<string, unknown>) => ({
		role: "toolResult",
		toolCallId: "c1",
		toolName,
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: 0,
	});

	test("tool_execution_end of a bash call swaps the trace for the shellTrace marker and keeps the other details", () => {
		const details = { exitCode: 3, replies: ["one"], async: { state: "completed" }, trace };
		const event = ended("bash", details);
		const wire = toWireEvent("trace-end", event);
		expect(wire).toEqual({
			type: "tool_execution_end",
			toolCallId: "c1",
			toolName: "bash",
			result: {
				content: [{ type: "text", text: "ok" }],
				details: { exitCode: 3, replies: ["one"], async: { state: "completed" }, shellTrace: true },
			},
		});
		// The session's live objects are never mutated.
		expect(details.trace).toBe(trace);
		expect(JSON.stringify(wire)).not.toContain('"trace"');
		expect(JSON.stringify(wire)).not.toContain("tttt");
	});

	test("a bash result without a trace ships unchanged, without a marker, and other tools' results too", () => {
		const plain = ended("bash", { exitCode: 0 });
		expect(toWireEvent("trace-plain", plain) as unknown).toBe(plain);
		expect(JSON.stringify(plain)).not.toContain("shellTrace");
		const other = ended("read", { trace });
		expect(toWireEvent("trace-other", other) as unknown).toBe(other);
	});

	test("a partial's trace never ships, nor does it prime a late joiner", () => {
		const entry = { handle: "trace-update" } as SessionEntry;
		const update = {
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			args: {},
			partialResult: { content: [{ type: "text", text: "so far" }], details: { trace } },
		} as unknown as AgentSessionEvent;
		const wire = toWireEvent(entry.handle, update);
		expect(wire).toEqual({
			type: "tool_execution_update",
			toolCallId: "c1",
			toolName: "bash",
			output: "so far",
		});
		expect(JSON.stringify(streamingPrimeFrames(entry))).not.toContain("tttt");
	});

	test("history swaps a bash result's trace for the marker, in the single-frame and the chunked shape", () => {
		const message = toolResult("bash", "out", { exitCode: 0, trace });
		const [single] = historyFrames([message] as never);
		expect(single.messages[0]).toEqual(
			toolResult("bash", "out", { exitCode: 0, shellTrace: true }) as never,
		);
		expect(message.details.trace).toBe(trace);

		const filler = {
			role: "user",
			content: [{ type: "text", text: "y".repeat(600 * 1024) }],
			timestamp: 0,
		};
		const frames = historyFrames([filler, message, filler] as never);
		expect(frames.length).toBeGreaterThan(1);
		expect(JSON.stringify(frames)).not.toContain("tttt");
		const sent = frames.flatMap((f) => f.messages)[1];
		expect(sent).toEqual(toolResult("bash", "out", { exitCode: 0, shellTrace: true }) as never);
	});

	test("a message over the ceiling only because of its trace ships its output unclipped", () => {
		const output = "o".repeat(200 * 1024);
		const bulky = { ...trace, events: "t".repeat(2 * 1024 * 1024) };
		const message = toolResult("bash", output, { exitCode: 0, trace: bulky });
		const filler = {
			role: "user",
			content: [{ type: "text", text: "y".repeat(600 * 1024) }],
			timestamp: 0,
		};
		const frames = historyFrames([filler, message] as never);
		const sent = frames.flatMap((f) => f.messages)[1];
		expect(sent).toEqual(toolResult("bash", output, { exitCode: 0, shellTrace: true }) as never);
	});

	test("history keeps another tool's details", () => {
		const message = toolResult("read", "out", { trace });
		const [single] = historyFrames([message] as never);
		expect(single.messages[0]).toBe(message as never);
	});
});
