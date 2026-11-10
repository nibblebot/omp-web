import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ChatItem, ToolItem } from "../../state";
import { createHistoryBuilder, TOOL_OUTPUT_CAP } from "../../chat/history-items";

// Messages are minimal shapes; the builder reads only the fields set here.
function msg(value: Record<string, unknown>): AgentMessage {
	return value as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
	return msg({ role: "user", content: text, timestamp: 1000 });
}

function assistantCalling(...calls: Array<{ id: string; name: string }>): AgentMessage {
	return msg({
		role: "assistant",
		content: [
			{ type: "text", text: "working" },
			...calls.map((call) => ({
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: { path: `${call.id}.ts` },
			})),
		],
	});
}

function result(
	toolCallId: string,
	text: string,
	over: Record<string, unknown> = {},
): AgentMessage {
	return msg({
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		...over,
	});
}

function tools(items: readonly ChatItem[]): ToolItem[] {
	return items.filter((item): item is ToolItem => item.kind === "tool");
}

describe("createHistoryBuilder", () => {
	test("pairs a result with its call inside one append", () => {
		const built = createHistoryBuilder().append([
			user("go"),
			assistantCalling({ id: "c1", name: "read" }),
			result("c1", "file body", { details: { lines: 3 } }),
		]);
		expect(built.items.map((item) => item.kind)).toEqual(["user", "assistant", "tool"]);
		const [tool] = tools(built.items);
		expect(tool).toMatchObject({
			toolCallId: "c1",
			name: "read",
			args: { path: "c1.ts" },
			status: "done",
			output: "file body",
			details: { lines: 3 },
		});
		// Settled before it was ever handed out: nothing to patch.
		expect(built.patched).toEqual([]);
	});

	test("a result in a later append patches the emitted ToolItem in place", () => {
		const builder = createHistoryBuilder();
		const first = builder.append([assistantCalling({ id: "c1", name: "read" })]);
		const [tool] = tools(first.items);
		expect(tool?.status).toBe("running");
		expect(tool?.output).toBe("");

		const second = builder.append([result("c1", "late output", { isError: true })]);
		expect(second.items).toEqual([]);
		expect(second.patched).toHaveLength(1);
		expect(second.patched[0]).toBe(tool as ToolItem);
		expect(tool).toMatchObject({ status: "error", output: "late output" });
	});

	test("pairs across pages while a sibling call stays pending", () => {
		const builder = createHistoryBuilder();
		const first = builder.append([
			assistantCalling({ id: "a", name: "read" }, { id: "b", name: "read" }),
			result("a", "A"),
		]);
		const [a, b] = tools(first.items);
		expect(a?.status).toBe("done");
		expect(b?.status).toBe("running");

		const second = builder.append([result("b", "B")]);
		expect(second.patched).toEqual([b as ToolItem]);
		expect(b).toMatchObject({ status: "done", output: "B" });
		expect(a?.output).toBe("A");
	});

	test("an unmatched result becomes its own settled tool item", () => {
		const builder = createHistoryBuilder();
		const built = builder.append([result("orphan", "stray", { toolName: "bash", isError: true })]);
		expect(built.items).toHaveLength(1);
		expect(built.items[0]).toMatchObject({
			kind: "tool",
			toolCallId: "orphan",
			name: "bash",
			args: null,
			status: "error",
			output: "stray",
		});
		// A repeat for the same id settles that item instead of adding another.
		const again = builder.append([result("orphan", "stray 2")]);
		expect(again.items).toEqual([]);
		expect(again.patched[0]).toBe(built.items[0] as ToolItem);
	});

	test("keeps the tail of an output past the cap", () => {
		const long = `${"a".repeat(TOOL_OUTPUT_CAP)}${"b".repeat(100)}`;
		const built = createHistoryBuilder().append([
			assistantCalling({ id: "c1", name: "read" }),
			result("c1", long),
		]);
		const [tool] = tools(built.items);
		expect(tool?.output).toHaveLength(TOOL_OUTPUT_CAP);
		expect(tool?.output.endsWith("b".repeat(100))).toBe(true);
	});

	test("allocates ids from the supplied sequence across appends", () => {
		let next = 100;
		const builder = createHistoryBuilder(() => next++);
		const first = builder.append([user("a"), assistantCalling({ id: "c1", name: "read" })]);
		const second = builder.append([user("b")]);
		expect([...first.items, ...second.items].map((item) => item.id)).toEqual([100, 101, 102, 103]);
	});

	test("a call starts when its assistant message completed; an older message without the stamp leaves it unset", () => {
		const stamped = msg({
			...(assistantCalling({ id: "c1", name: "wait" }) as object),
			completedAt: 5_000,
		});
		const [call] = tools(createHistoryBuilder().append([stamped]).items);
		expect(call?.startedAt).toBe(5_000);
		const [old] = tools(
			createHistoryBuilder().append([assistantCalling({ id: "c2", name: "wait" })]).items,
		);
		expect(old).not.toHaveProperty("startedAt");
	});
});

function aborted(content: unknown[] = []): AgentMessage {
	return msg({ role: "assistant", content, stopReason: "aborted" });
}

describe("interrupted tool status", () => {
	test("a synthetic or interrupted marker on the result reads interrupted, whatever isError says", () => {
		const built = createHistoryBuilder().append([
			assistantCalling({ id: "a", name: "read" }, { id: "b", name: "read" }),
			result("a", "gone", { isError: true, details: { __synthetic: true, source: "orphan" } }),
			result("b", "cut", { details: { __interrupted: true } }),
			result("orphan", "stray", { isError: true, details: { __synthetic: true } }),
		]);
		expect(tools(built.items).map((item) => item.status)).toEqual([
			"interrupted",
			"interrupted",
			"interrupted",
		]);
	});

	test("an unmarked error stays error and a falsy marker does not count", () => {
		const built = createHistoryBuilder().append([
			assistantCalling({ id: "a", name: "read" }, { id: "b", name: "read" }),
			result("a", "boom", { isError: true, details: {} }),
			result("b", "ok", { details: { __synthetic: false } }),
		]);
		expect(tools(built.items).map((item) => item.status)).toEqual(["error", "done"]);
	});

	test("an aborted assistant interrupts the error results of the call round before it", () => {
		const built = createHistoryBuilder().append([
			user("go"),
			assistantCalling({ id: "a", name: "bash" }, { id: "b", name: "read" }),
			result("a", "killed", { isError: true, details: {} }),
			result("b", "fine", { details: {} }),
			aborted(),
		]);
		expect(tools(built.items).map((item) => item.status)).toEqual(["interrupted", "done"]);
		expect(built.patched).toEqual([]);
	});

	test("a call still running when the abort lands becomes interrupted", () => {
		const built = createHistoryBuilder().append([
			user("go"),
			assistantCalling({ id: "a", name: "bash" }),
			aborted(),
		]);
		expect(tools(built.items)[0]?.status).toBe("interrupted");
	});

	test("the relabel reaches items of an earlier append, in place, and reports them patched", () => {
		const builder = createHistoryBuilder();
		const first = builder.append([
			user("go"),
			assistantCalling({ id: "a", name: "bash" }, { id: "b", name: "read" }),
			result("a", "killed", { isError: true, details: {} }),
			result("b", "fine", { details: {} }),
		]);
		const [a, b] = tools(first.items) as [ToolItem, ToolItem];
		expect(a.status).toBe("error");

		const second = builder.append([aborted()]);
		expect(a.status).toBe("interrupted");
		expect(b.status).toBe("done");
		expect(second.patched).toEqual([a]);
	});

	test("only the closest earlier round is relabelled, not older legitimate errors", () => {
		const built = createHistoryBuilder().append([
			user("go"),
			assistantCalling({ id: "old", name: "bash" }),
			result("old", "real failure", { isError: true, details: {} }),
			assistantCalling({ id: "new", name: "bash" }),
			result("new", "killed", { isError: true, details: {} }),
			aborted(),
		]);
		expect(tools(built.items).map((item) => item.status)).toEqual(["error", "interrupted"]);
	});

	test("an aborted turn before any call leaves the previous turn alone", () => {
		const built = createHistoryBuilder().append([
			user("one"),
			assistantCalling({ id: "a", name: "bash" }),
			result("a", "real failure", { isError: true, details: {} }),
			user("two"),
			aborted(),
		]);
		expect(tools(built.items)[0]?.status).toBe("error");
	});

	test("a call with no result and no abort stays running", () => {
		const built = createHistoryBuilder().append([
			user("go"),
			assistantCalling({ id: "a", name: "ask" }),
		]);
		expect(tools(built.items)[0]?.status).toBe("running");
	});
});
