import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { WireSessionEvent } from "#lib/wire/protocol";
import { setState, state } from "../../state";
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
});
