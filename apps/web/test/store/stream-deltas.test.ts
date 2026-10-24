import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { WireSessionEvent } from "#lib/wire/protocol";
import { setState, state } from "../../state";
import { createHistoryBuilder } from "../../chat/history-items";
import { applyEvent } from "../../store/chat";

const assistantStart = {
	type: "message_start",
	message: { role: "assistant", content: [] },
} as unknown as WireSessionEvent;

function delta(
	contentIndex: number,
	text: string,
	kind: "text" | "thinking" = "text",
): WireSessionEvent {
	return {
		type: "message_update",
		assistantMessageEvent: { type: `${kind}_delta`, contentIndex, delta: text },
	};
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
	setState("live", { active: false, blocks: [] });
	setState("items", []);
	setState("settingsModel", null as never);
});

describe("streamed deltas (slim message_update frames)", () => {
	test("appends accumulate per content block and keep the block object", async () => {
		// Pacing off so the reveal writes each delta in one flush.
		setState("settingsModel", {
			tabs: [
				{ id: "display", groups: [{ items: [{ path: "display.smoothStreaming", value: false }] }] },
			],
		} as never);
		applyEvent(assistantStart);
		applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		});
		applyEvent(delta(0, "Hello"));
		await tick();
		const block = state.live.blocks[0];
		expect(block?.text).toBe("Hello");

		applyEvent(delta(0, ", wor"));
		applyEvent(delta(0, "ld"));
		applyEvent(delta(1, "thinking", "thinking"));
		await tick();

		// Same object: a replacement would remount the StreamingBlock in <For>.
		expect(state.live.blocks[0]).toBe(block);
		expect(state.live.blocks[0]?.text).toBe("Hello, world");
		expect(state.live.blocks[1]).toMatchObject({ kind: "thinking", text: "thinking" });
	});

	test("message_end commits the full message and ends the live turn", async () => {
		applyEvent(assistantStart);
		applyEvent(delta(0, "partial"));
		applyEvent({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "partial text, settled" }],
			} as unknown as AgentMessage,
		});
		await tick();
		expect(state.live.active).toBe(false);
		const last = state.items.at(-1);
		expect(last).toMatchObject({
			kind: "assistant",
			blocks: [{ kind: "text", text: "partial text, settled" }],
		});
	});

	test("a late joiner primed mid-reply keeps the partial blocks and appends later deltas", async () => {
		setState("settingsModel", {
			tabs: [
				{ id: "display", groups: [{ items: [{ path: "display.smoothStreaming", value: false }] }] },
			],
		} as never);
		applyEvent({
			type: "message_start",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Hello" },
					{ type: "thinking", thinking: "hm" },
				],
			},
		} as unknown as WireSessionEvent);
		await tick();
		expect(state.live.blocks[0]).toMatchObject({ kind: "text", text: "Hello" });
		expect(state.live.blocks[1]).toMatchObject({ kind: "thinking", text: "hm" });

		applyEvent(delta(0, ", world"));
		await tick();
		expect(state.live.blocks[0]?.text).toBe("Hello, world");
	});

	test("an unknown sub-event type is ignored and leaves the live blocks untouched", async () => {
		setState("settingsModel", {
			tabs: [
				{ id: "display", groups: [{ items: [{ path: "display.smoothStreaming", value: false }] }] },
			],
		} as never);
		applyEvent({
			type: "message_start",
			message: { role: "assistant", content: [{ type: "text", text: "Hi" }] },
		} as unknown as WireSessionEvent);
		await tick();
		const before = state.live.blocks[0];
		applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "future_sub_event", contentIndex: 0 },
		} as unknown as WireSessionEvent);
		await tick();
		expect(state.live.blocks[0]).toBe(before);
		expect(state.live.blocks[0]?.text).toBe("Hi");
	});
});

describe("narration thinking blocks (ThinkingContent.narration)", () => {
	const content = [
		{ type: "thinking", thinking: "plan the edit", thinkingSignature: "sig-a" },
		{
			type: "thinking",
			thinking: "Checking the callers now.",
			thinkingSignature: "sig-b",
			narration: true,
		},
		{ type: "text", text: "Done." },
	];

	test("a live message renders narration as answer text at message_end and keeps reasoning thinking", async () => {
		applyEvent(assistantStart);
		applyEvent(delta(1, "Checking the callers now.", "thinking"));
		await tick();
		// No flag on the slim stream: it streams as thinking until the full message lands.
		expect(state.live.blocks[1]?.kind).toBe("thinking");
		applyEvent({
			type: "message_end",
			message: { role: "assistant", content } as unknown as AgentMessage,
		});
		expect(state.items.at(-1)).toMatchObject({
			kind: "assistant",
			blocks: [
				{ kind: "thinking", text: "plan the edit" },
				{ kind: "text", text: "Checking the callers now." },
				{ kind: "text", text: "Done." },
			],
		});
	});

	test("history frames build the same blocks", () => {
		const { items } = createHistoryBuilder().append([
			{ role: "assistant", content } as unknown as AgentMessage,
		]);
		expect(items[0]).toMatchObject({
			kind: "assistant",
			blocks: [
				{ kind: "thinking", text: "plan the edit" },
				{ kind: "text", text: "Checking the callers now." },
				{ kind: "text", text: "Done." },
			],
		});
	});

	test("a late joiner primed past a finished narration block seeds it as text", async () => {
		applyEvent({
			type: "message_start",
			message: { role: "assistant", content: content.slice(0, 2) },
		} as unknown as WireSessionEvent);
		expect(state.live.blocks.map((b) => b?.kind)).toEqual(["thinking", "text"]);
	});
});
