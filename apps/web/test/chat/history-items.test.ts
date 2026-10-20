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
});
