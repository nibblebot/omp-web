/**
 * A live tool call's start is stamped on the session's clock (its assistant message's
 * `completedAt`), as a history load stamps it, never the browser's: the wait card compares
 * it with the session's `settledAtMs`, and a remote session's clock can differ by minutes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { WireSessionEvent } from "#lib/wire/protocol";
import { setState, state, type ToolItem } from "../../state";
import { applyEvent } from "../../store/chat";

function ev(event: unknown): void {
	applyEvent(event as WireSessionEvent);
}

function calls(completedAt: number | undefined, ...ids: string[]): void {
	ev({
		type: "message_end",
		message: {
			role: "assistant",
			content: ids.map((id) => ({ type: "toolCall", id, name: "wait", arguments: {} })),
			stopReason: "toolUse",
			...(completedAt !== undefined ? { completedAt } : {}),
		},
	});
	for (const id of ids)
		ev({ type: "tool_execution_start", toolCallId: id, toolName: "wait", args: {} });
}

function starts(): Array<number | undefined> {
	return state.items
		.filter((item): item is ToolItem => item.kind === "tool")
		.map((item) => item.startedAt);
}

afterEach(() => {
	setState("items", []);
});

describe("live tool start clock", () => {
	test("every call of a turn starts at its assistant message's completedAt", () => {
		calls(1_000, "a", "b");
		calls(9_000, "c");
		expect(starts()).toEqual([1_000, 1_000, 9_000]);
	});

	test("a message without completedAt leaves the start unset rather than using the browser clock", () => {
		calls(undefined, "a");
		expect(starts()).toEqual([undefined]);
	});
});
