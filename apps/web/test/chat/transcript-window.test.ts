/**
 * Which tail of the transcript is mounted: opening at the tail, following it while
 * pinned, growing upward on demand, and never starting inside a run that draws at
 * its first call.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as solid from "solid-js";
import * as solidStore from "solid-js/store";
import type { ChatItem, ToolItem } from "../../state";
import type * as IndexModule from "../../chat/transcript-index";
import type * as WindowModule from "../../chat/transcript-window";

// bun resolves "solid-js" and its store to the SSR builds, where nothing notifies; the client builds give the
// window live signals. Same technique as activities/keyed-rows.test.ts: mock them for this suite, restore after.
const CLIENT_SOLID: string = "solid-js/dist/solid.js";
const CLIENT_STORE: string = "solid-js/store/dist/store.js";
const originalSolid = { ...solid };
const originalStore = { ...solidStore };

let clientSolid: typeof solid;
let clientStore: typeof solidStore;
let createTranscriptIndex: typeof IndexModule.createTranscriptIndex;
let createTranscriptWindow: typeof WindowModule.createTranscriptWindow;
let WINDOW_INITIAL: number;
let WINDOW_CHUNK: number;

beforeAll(async () => {
	clientSolid = { ...(await import(CLIENT_SOLID)) };
	mock.module("solid-js", () => clientSolid);
	clientStore = { ...(await import(CLIENT_STORE)) };
	mock.module("solid-js/store", () => clientStore);
	const indexPath: string = "../../chat/transcript-index.ts?fresh=transcript-window-test";
	const windowPath: string = "../../chat/transcript-window.ts?fresh=transcript-window-test";
	({ createTranscriptIndex } = await import(indexPath));
	({ createTranscriptWindow, WINDOW_INITIAL, WINDOW_CHUNK } = await import(windowPath));
});

afterAll(() => {
	mock.module("solid-js", () => originalSolid);
	mock.module("solid-js/store", () => originalStore);
});

let nextId = 1;
const user = (): ChatItem => ({ kind: "user", id: nextId++, text: "go" });
const prose = (): ChatItem => ({
	kind: "assistant",
	id: nextId++,
	blocks: [{ kind: "text", text: "done" }],
});
function tool(name: string, over: Partial<ToolItem> = {}): ToolItem {
	const id = nextId++;
	return {
		kind: "tool",
		id,
		toolCallId: `c${id}`,
		name,
		args: {},
		status: "running",
		output: "",
		...over,
	};
}

const OPTIONS: IndexModule.TranscriptIndexOptions = {
	consolidated: true,
	hideToolActivity: false,
	hideActivityCards: false,
	hideThinking: false,
	proseOnlyThinking: true,
	showTokenUsage: false,
	turnTime: false,
	cacheMiss: false,
};

describe("createTranscriptWindow", () => {
	function mount(count: number, pinned = true) {
		const items: ChatItem[] = [];
		for (let i = 0; i < count; i++) items.push(i % 2 === 0 ? user() : prose());
		const [state, setState] = clientStore.createStore<{ items: ChatItem[] }>({ items });
		const [isPinned, setPinned] = clientSolid.createSignal(pinned);
		const index = createTranscriptIndex(
			() => state.items,
			() => OPTIONS,
		);
		const win = createTranscriptWindow(() => state.items, {
			pinned: isPinned,
			leadOf: index.leadOf,
		});
		const push = (item: ChatItem) => setState("items", state.items.length, item);
		return { state, setState, win, setPinned, push };
	}

	test("opens at the tail and counts what it leaves out", () => {
		clientSolid.createRoot((dispose) => {
			const { state, win } = mount(500);
			expect(win.items()).toHaveLength(WINDOW_INITIAL);
			expect(win.items().at(-1)?.id).toBe(state.items.at(-1)?.id);
			expect(win.hiddenBefore()).toBe(500 - WINDOW_INITIAL);
			dispose();
		});
	});

	test("a short transcript is mounted whole", () => {
		clientSolid.createRoot((dispose) => {
			const { win } = mount(WINDOW_INITIAL - 1);
			expect(win.items()).toHaveLength(WINDOW_INITIAL - 1);
			expect(win.hiddenBefore()).toBe(0);
			expect(win.showEarlier()).toBe(false);
			dispose();
		});
	});

	test("showEarlier mounts older items above the first, down to the oldest", () => {
		clientSolid.createRoot((dispose) => {
			const { state, win } = mount(200);
			expect(win.showEarlier()).toBe(true);
			expect(win.items()).toHaveLength(WINDOW_INITIAL + WINDOW_CHUNK);
			while (win.showEarlier()) {
				// keep going
			}
			expect(win.hiddenBefore()).toBe(0);
			expect(win.items().map((it) => it.id)).toEqual(state.items.map((it) => it.id));
			dispose();
		});
	});

	test("a pinned window follows the tail without growing past a chunk over its size", () => {
		clientSolid.createRoot((dispose) => {
			const { state, win, push } = mount(300);
			for (let i = 0; i < 300; i++) {
				push(prose());
				expect(win.items().at(-1)?.id).toBe(state.items.at(-1)?.id);
				expect(win.items().length).toBeLessThanOrEqual(WINDOW_INITIAL + WINDOW_CHUNK + 1);
			}
			dispose();
		});
	});

	test("an unpinned window keeps its first item while the transcript grows, and trims on re-pin", () => {
		clientSolid.createRoot((dispose) => {
			const { win, push, setPinned } = mount(300);
			setPinned(false);
			const first = win.items()[0]!.id;
			for (let i = 0; i < 200; i++) push(prose());
			expect(win.items()[0]!.id).toBe(first);
			expect(win.items().length).toBe(WINDOW_INITIAL + 200);
			setPinned(true);
			expect(win.items().length).toBe(WINDOW_INITIAL);
			dispose();
		});
	});

	test("switching to another list opens that one at its tail", () => {
		clientSolid.createRoot((dispose) => {
			const { state, setState, win } = mount(300);
			win.showEarlier();
			const next: ChatItem[] = [];
			for (let i = 0; i < 100; i++) next.push(prose());
			setState("items", next);
			expect(win.items()).toHaveLength(WINDOW_INITIAL);
			expect(win.items().at(-1)?.id).toBe(state.items.at(-1)?.id);
			dispose();
		});
	});

	test("never begins inside a run that draws at its first call", () => {
		clientSolid.createRoot((dispose) => {
			const items: ChatItem[] = [user()];
			const calls: ToolItem[] = [];
			for (let i = 0; i < 100; i++) {
				calls.push(tool("read", { status: "done" }));
				items.push(calls[i]!);
			}
			const [state] = clientStore.createStore<{ items: ChatItem[] }>({ items });
			const index = createTranscriptIndex(
				() => state.items,
				() => OPTIONS,
			);
			const win = createTranscriptWindow(() => state.items, {
				pinned: () => true,
				leadOf: index.leadOf,
			});
			// The default start would fall in the middle of the 100-call run.
			expect(win.items()[0]!.id).toBe(calls[0]!.id);
			dispose();
		});
	});

	test("reveal mounts an older item and reports a missing one", () => {
		clientSolid.createRoot((dispose) => {
			const { state, win } = mount(300);
			const old = state.items[10]!;
			expect(win.items().some((it) => it.id === old.id)).toBe(false);
			expect(win.reveal((it) => it.id === old.id)).toBe(true);
			expect(win.items().some((it) => it.id === old.id)).toBe(true);
			expect(win.reveal((it) => it.id === -1)).toBe(false);
			dispose();
		});
	});
});
