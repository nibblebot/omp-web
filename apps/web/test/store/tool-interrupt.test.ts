/**
 * Live tool status classification: marker results and aborted assistant
 * messages read as interrupted; a settled idle turn interrupts what is left running.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { WireSessionEvent } from "#lib/wire/protocol";
import { setState, state, type ToolItem } from "../../state";
import { applyEvent, settleRunningTools } from "../../store/chat";

function ev(event: unknown): void {
	applyEvent(event as WireSessionEvent);
}

function toolCallsMessage(...ids: string[]): unknown {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: { command: id } })),
		stopReason: "toolUse",
	};
}

function startTool(id: string): void {
	ev({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: id } });
}

function endTool(id: string, over: { isError?: boolean; details?: unknown } = {}): void {
	ev({
		type: "tool_execution_end",
		toolCallId: id,
		toolName: "bash",
		isError: over.isError,
		result: { content: [{ type: "text", text: "out" }], details: over.details },
	});
}

function statuses(): string[] {
	return state.items
		.filter((item): item is ToolItem => item.kind === "tool")
		.map((item) => item.status);
}

afterEach(() => {
	setState("items", []);
	setState("streaming", false);
});

describe("live tool_execution_end markers", () => {
	test("__synthetic (any source) and __interrupted results read interrupted", () => {
		for (const id of ["a", "b", "c"]) startTool(id);
		endTool("a", { isError: true, details: { __synthetic: true, source: "orphan" } });
		endTool("b", { details: { __interrupted: true } });
		endTool("c", { details: { __synthetic: true, source: "other" } });
		expect(statuses()).toEqual(["interrupted", "interrupted", "interrupted"]);
	});

	test("unmarked results keep done and error", () => {
		for (const id of ["a", "b"]) startTool(id);
		endTool("a", { details: {} });
		endTool("b", { isError: true, details: {} });
		expect(statuses()).toEqual(["done", "error"]);
	});
});

describe("live abort relabel", () => {
	test("an Esc abort turns the killed call's error into interrupted and leaves a done sibling", () => {
		ev({ type: "message_start", message: { role: "user", content: "go" } });
		ev({ type: "message_end", message: toolCallsMessage("a", "b") });
		startTool("a");
		startTool("b");
		endTool("a", { isError: true, details: {} });
		endTool("b", { details: {} });
		expect(statuses()).toEqual(["error", "done"]);

		ev({ type: "message_start", message: { role: "assistant", content: [] } });
		ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
		expect(statuses()).toEqual(["interrupted", "done"]);
		expect(state.items.at(-1)).toMatchObject({ kind: "assistant", interrupted: true });
	});

	test("a call still running when the abort lands becomes interrupted", () => {
		ev({ type: "message_start", message: { role: "user", content: "go" } });
		ev({ type: "message_end", message: toolCallsMessage("a") });
		startTool("a");
		ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
		expect(statuses()).toEqual(["interrupted"]);
	});

	test("an older round's legitimate error is left alone", () => {
		ev({ type: "message_start", message: { role: "user", content: "go" } });
		ev({ type: "message_end", message: toolCallsMessage("old") });
		startTool("old");
		endTool("old", { isError: true, details: {} });
		ev({ type: "message_end", message: toolCallsMessage("new") });
		startTool("new");
		endTool("new", { isError: true, details: {} });
		ev({ type: "message_end", message: { role: "assistant", content: [], stopReason: "aborted" } });
		expect(statuses()).toEqual(["error", "interrupted"]);
	});

	test("a normal assistant message does not relabel anything", () => {
		ev({ type: "message_end", message: toolCallsMessage("a") });
		startTool("a");
		endTool("a", { isError: true, details: {} });
		ev({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "sorry" }],
				stopReason: "stop",
			},
		});
		expect(statuses()).toEqual(["error"]);
	});
});

describe("settleRunningTools", () => {
	test("leftover running calls become interrupted; settled ones keep their status", () => {
		for (const id of ["a", "b"]) startTool(id);
		endTool("a", { details: {} });
		settleRunningTools();
		expect(statuses()).toEqual(["done", "interrupted"]);
	});
});
