import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SSE_EVENT_NAME } from "#lib/wire/protocol";
import type { ClientCommand, ServerFrame } from "#lib/wire/protocol";
import { activateFeatures } from "../../features/registry";
import { connect, setState, state } from "../../state";

// ---------------------------------------------------------------------------
// Minimal /events transport double (same shape as test/state.test.ts).
// connect() registers its SSE handler on a FakeEventSource; tests dispatch
// frames through it exactly like the real stream.
// ---------------------------------------------------------------------------
type SseHandler = (ev: { data: string; lastEventId?: string }) => void;

class FakeEventSource {
	static instances: FakeEventSource[] = [];
	static handlers = new Map<string, SseHandler>();
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public readonly url: string) {
		FakeEventSource.instances.push(this);
	}
	addEventListener(type: string, handler: SseHandler): void {
		FakeEventSource.handlers.set(type, handler);
	}
	close(): void {}
	static dispatch(type: string, data: string, lastEventId?: string): void {
		FakeEventSource.handlers.get(type)?.({ data, lastEventId });
	}
}

const posted: ClientCommand[] = [];

function attached(sessionId: string): ServerFrame {
	return { type: "attached", sessionId };
}

function dispatch(frame: ServerFrame): void {
	FakeEventSource.dispatch(SSE_EVENT_NAME, JSON.stringify(frame));
}

function userMsg(text: string): {
	role: "user";
	content: Array<{ type: "text"; text: string }>;
	timestamp: number;
} {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}

function assistantMsg(text: string): {
	role: "assistant";
	content: Array<{ type: "text"; text: string }>;
} {
	return { role: "assistant", content: [{ type: "text", text }] };
}

function itemCounts(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const item of state.items) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
	return counts;
}

beforeAll(async () => {
	await activateFeatures(["advisor"]);
});

beforeEach(() => {
	posted.length = 0;
	FakeEventSource.instances.length = 0;
	FakeEventSource.handlers.clear();
	globalThis.location = { search: "" } as Location;
	globalThis.window = {
		setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
	} as unknown as Window & typeof globalThis;
	globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		if (typeof init?.body === "string") posted.push(JSON.parse(init.body) as ClientCommand);
		return { ok: true, status: 202 } as Response;
	}) as unknown as typeof fetch;
	setState("items", []);
});

describe("advisor notes render inline (TUI advisor card parity)", () => {
	const notes = [
		{ note: "check the null path", severity: "concern" },
		{ note: "ship it", advisor: "reviewer", turnsAgo: 2 },
	];
	const advisorMsg = {
		role: "custom",
		customType: "advisor",
		display: true,
		content: "<advisory>…</advisory>",
		details: { notes },
		timestamp: 0,
	};

	function primed(): void {
		connect();
		FakeEventSource.instances.at(-1)!.onopen?.();
		dispatch(attached("session-a"));
	}

	test("history: advisor messages become advisor items; other custom messages stay hidden", () => {
		primed();
		dispatch({
			type: "history",
			messages: [
				userMsg("q"),
				advisorMsg,
				{
					role: "custom",
					customType: "loop-continuation",
					display: false,
					content: "x",
					timestamp: 0,
				},
				assistantMsg("a"),
			],
		} as ServerFrame);
		expect(state.items.map((it) => it.kind)).toEqual(["user", "advisor", "assistant"]);
		expect(state.items[1]).toMatchObject({ kind: "advisor", notes });
	});

	test("live: a steered/preserved advisor card (message_start + message_end) lands exactly once", () => {
		primed();
		dispatch({ type: "history", messages: [] });
		const ev = (event: unknown): ServerFrame => ({ type: "event", event }) as ServerFrame;
		dispatch(ev({ type: "message_start", message: advisorMsg }));
		dispatch(ev({ type: "message_end", message: advisorMsg }));
		expect(itemCounts()).toEqual({ advisor: 1 });
		expect(state.items[0]).toMatchObject({ kind: "advisor", notes });
	});
});
