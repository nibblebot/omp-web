/**
 * Tool calls cross the wire slimmed: a running tool's update carries only the
 * appended output, the tool-result message events and the messages repeated
 * by turn_end/agent_end are not sent. These tests drive the session's real
 * producer (`toWireEvent`, the ring, late-join priming) into the web's real
 * `applyEvent` and check what the transcript shows.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { WireSessionEvent } from "#lib/wire/protocol";
import type { SessionEntry } from "../../../session/session-entry";
import {
	broadcastHistory,
	broadcastTo,
	ringAfter,
	snapshotDeltaSeq,
	streamingPrimeFrames,
	toWireEvent,
} from "../../../session/client-delivery";
import { loadHistory, setState, state } from "../../state";
import { applyEvent } from "../../store/chat";

/** Let the store's coalesced flush run (it drains on a microtask where there is no rAF). */
async function tick(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

let nextHandle = 0;
/** A fresh session handle per test: the producer keeps per-handle tool state. */
function freshEntry(): SessionEntry {
	return { handle: `tool-wire-${nextHandle++}` } as SessionEntry;
}

const CALL = "call_1";

function assistantWithCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "running it" },
			{ type: "toolCall", id: CALL, name: "bash", arguments: { command: "make" } },
		],
		stopReason: "toolUse",
	} as unknown as AssistantMessage;
}

const userMessage: UserMessage = { role: "user", content: "build", timestamp: 1 };

function toolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: CALL,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
	};
}

const start = {
	type: "tool_execution_start",
	toolCallId: CALL,
	toolName: "bash",
	args: { command: "make" },
} as unknown as AgentSessionEvent;

/** The SDK repeats the call's args and the whole accumulated output in every update. */
function update(text: string, extra: Record<string, unknown> = {}): AgentSessionEvent {
	return {
		type: "tool_execution_update",
		toolCallId: CALL,
		toolName: "bash",
		args: { command: "make" },
		partialResult: { content: [{ type: "text", text }], details: {}, ...extra },
	} as unknown as AgentSessionEvent;
}

function end(text: string): AgentSessionEvent {
	return {
		type: "tool_execution_end",
		toolCallId: CALL,
		toolName: "bash",
		result: { content: [{ type: "text", text }], details: {} },
	} as unknown as AgentSessionEvent;
}

/** One browser: what the session sends for `event`, JSON round-tripped like the wire, applied by the web. */
function deliver(entry: SessionEntry, event: AgentSessionEvent): WireSessionEvent | null {
	const wire = toWireEvent(entry.handle, event);
	if (wire === null) return null;
	broadcastTo(entry.handle, { type: "event", event: wire });
	applyEvent(JSON.parse(JSON.stringify(wire)) as WireSessionEvent);
	return wire;
}

function cardOutput(): string | undefined {
	const card = state.items.find((item) => item.kind === "tool");
	return card?.kind === "tool" ? card.output : undefined;
}

/** A browser that attached mid-tool: history holds the call as a running card with no output. */
function attachMidTool(): void {
	loadHistory([userMessage, assistantWithCall()]);
}

afterEach(() => {
	setState("items", []);
	setState("streaming", false);
});

describe("running tool output on the wire", () => {
	test("the card shows each partial the SDK reported, whether it grew, repeated, or rolled over", async () => {
		const entry = freshEntry();
		attachMidTool();
		deliver(entry, start);

		deliver(entry, update("line 1\n"));
		await tick();
		expect(cardOutput()).toBe("line 1\n");

		deliver(entry, update("line 1\nline 2\n"));
		await tick();
		expect(cardOutput()).toBe("line 1\nline 2\n");

		// A repeat changes nothing the card shows and is not sent at all.
		expect(deliver(entry, update("line 1\nline 2\n"))).toBeNull();

		// A tool that keeps only a window of its output is not an append.
		deliver(entry, update("line 2\nline 3\n"));
		await tick();
		expect(cardOutput()).toBe("line 2\nline 3\n");

		deliver(entry, end("line 2\nline 3\nexit 0\n"));
		const card = state.items.find((item) => item.kind === "tool");
		expect(card).toMatchObject({ status: "done", output: "line 2\nline 3\nexit 0\n" });
	});

	test("updates between two frames of the browser merge into one append", async () => {
		const entry = freshEntry();
		attachMidTool();
		deliver(entry, start);
		deliver(entry, update("a"));
		deliver(entry, update("ab"));
		deliver(entry, update("abc"));
		await tick();
		expect(cardOutput()).toBe("abc");
		// The card keeps the tail it shows, however much arrives between flushes.
		const long = "x".repeat(20_000);
		deliver(entry, update(`abc${long}`));
		deliver(entry, update(`abc${long}y`));
		await tick();
		expect(cardOutput()).toBe(`${long}y`.slice(-8000));
	});

	test("images arrive once and survive text-only updates", async () => {
		const entry = freshEntry();
		attachMidTool();
		deliver(entry, start);
		const image = { type: "image", data: "aGk=", mimeType: "image/png" };
		const withImage = (text: string) =>
			({
				...update(text),
				partialResult: { content: [{ type: "text", text }, image] },
			}) as unknown as AgentSessionEvent;
		const first = deliver(entry, withImage("shot"));
		const second = deliver(entry, withImage("shot taken"));
		await tick();
		expect(first).toMatchObject({ images: [image] });
		expect(second).not.toHaveProperty("images");
		const card = state.items.find((item) => item.kind === "tool");
		expect(card).toMatchObject({ output: "shot taken", images: [image] });
	});

	test("a browser that attaches mid-tool is primed with the output so far, then follows the appends", async () => {
		const entry = freshEntry();
		// Browser A watches the whole call.
		attachMidTool();
		deliver(entry, start);
		deliver(entry, update("one\n"));
		deliver(entry, update("one\ntwo\n"));
		await tick();

		// Browser B attaches now: history rebuild, then the priming the session derives.
		attachMidTool();
		expect(cardOutput()).toBe("");
		for (const frame of streamingPrimeFrames(entry)) {
			applyEvent(JSON.parse(JSON.stringify(frame.event)) as WireSessionEvent);
		}
		await tick();
		expect(cardOutput()).toBe("one\ntwo\n");

		deliver(entry, update("one\ntwo\nthree\n"));
		await tick();
		expect(cardOutput()).toBe("one\ntwo\nthree\n");
		deliver(entry, end("one\ntwo\nthree\ndone\n"));
		expect(cardOutput()).toBe("one\ntwo\nthree\ndone\n");
		// A settled call is no longer primed.
		expect(streamingPrimeFrames(entry)).toEqual([]);
	});

	test("a stream that resumes from the ring replays the missed appends", async () => {
		const entry = freshEntry();
		attachMidTool();
		deliver(entry, start);
		deliver(entry, update("one\n"));
		await tick();
		const floor = snapshotDeltaSeq() - 1;
		// The stream is down while the session keeps sending.
		for (const text of ["one\ntwo\n", "one\ntwo\nthree\n"]) {
			const wire = toWireEvent(entry.handle, update(text));
			if (wire !== null) broadcastTo(entry.handle, { type: "event", event: wire });
		}
		for (const { value } of ringAfter(floor)) {
			const data = /^data: (.*)$/m.exec(value)![1];
			const frame = JSON.parse(data) as { event: WireSessionEvent };
			applyEvent(frame.event);
		}
		await tick();
		expect(cardOutput()).toBe("one\ntwo\nthree\n");
	});

	test("a history resync mid-tool is followed by a full snapshot, not an append onto the emptied card", async () => {
		const entry = freshEntry();
		attachMidTool();
		deliver(entry, start);
		deliver(entry, update("one\n"));
		deliver(entry, update("one\ntwo\n"));
		await tick();

		// A transcript-reloading call: the browsers rebuild the card from history.
		await broadcastHistory(entry.handle, []);
		attachMidTool();
		expect(cardOutput()).toBe("");

		deliver(entry, update("one\ntwo\nthree\n"));
		await tick();
		expect(cardOutput()).toBe("one\ntwo\nthree\n");
		// And the update after that is an append again.
		const next = deliver(entry, update("one\ntwo\nthree\nfour\n"));
		expect(next).toMatchObject({ output: "four\n", append: true });
	});
});

describe("wire cost of one tool call", () => {
	const OUTPUT = "x".repeat(39_999) + "\n";

	/** The events the SDK emits around one bash call that prints OUTPUT, as the profile harness saw them. */
	function sdkTurn(): AgentSessionEvent[] {
		const assistant = assistantWithCall();
		const result = toolResultMessage(OUTPUT);
		const final = {
			...assistantWithCall(),
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
		};
		return [
			{ type: "agent_start" },
			{ type: "message_start", message: userMessage },
			{ type: "message_end", message: userMessage },
			{ type: "turn_start" },
			{ type: "message_start", message: assistant },
			{ type: "message_end", message: assistant },
			start,
			update(OUTPUT),
			update(OUTPUT),
			end(OUTPUT),
			{ type: "message_start", message: result },
			{ type: "message_end", message: result },
			{ type: "turn_end", message: assistant, toolResults: [result] },
			{ type: "message_start", message: final },
			{ type: "message_end", message: final },
			{ type: "turn_end", message: final, toolResults: [] },
			{
				type: "agent_end",
				messages: [userMessage, assistant, result, final],
				yielded: true,
			},
		] as unknown as AgentSessionEvent[];
	}

	test("the output rides the wire about twice (progress and result), not seven times", () => {
		const entry = freshEntry();
		let raw = 0;
		let wireBytes = 0;
		for (const event of sdkTurn()) {
			raw += JSON.stringify(event).length;
			const wire = toWireEvent(entry.handle, event);
			if (wire !== null) wireBytes += JSON.stringify(wire).length;
		}
		expect(raw).toBeGreaterThan(6 * OUTPUT.length);
		expect(wireBytes).toBeLessThan(2 * OUTPUT.length + 4_000);
	});

	test("the transcript and turn state are the same as from the unslimmed stream", async () => {
		const entry = freshEntry();
		setState("items", []);
		setState("streaming", false);
		for (const event of sdkTurn()) deliver(entry, event);
		await tick();
		expect(state.streaming).toBe(false);
		expect(state.items.map((item) => item.kind)).toEqual([
			"user",
			"assistant",
			"tool",
			"assistant",
		]);
		expect(state.items.find((item) => item.kind === "tool")).toMatchObject({
			status: "done",
			output: OUTPUT.slice(-8000),
		});
	});

	test("agent_end keeps the last assistant outcome, turn_end is a bare marker, tool-result messages are not sent", () => {
		const entry = freshEntry();
		const errored = {
			...assistantWithCall(),
			stopReason: "error",
			errorMessage: "rate limited",
		};
		const events = [
			{ type: "message_start", message: toolResultMessage("x") },
			{ type: "message_end", message: toolResultMessage("x") },
			{ type: "turn_end", message: errored, toolResults: [toolResultMessage("x")] },
			{
				type: "agent_end",
				messages: [userMessage, assistantWithCall(), toolResultMessage("x"), errored],
				isTerminal: true,
				yielded: true,
			},
		] as unknown as AgentSessionEvent[];
		expect(events.map((event) => toWireEvent(entry.handle, event))).toEqual([
			null,
			null,
			{ type: "turn_end" },
			{
				type: "agent_end",
				isTerminal: true,
				yielded: true,
				lastAssistant: { stopReason: "error", errorMessage: "rate limited" },
			},
		]);
	});
});
