/**
 * The transcript index answers, per item id, what the whole-list builders
 * (tool runs, wait runs, turn metadata, the Activities panel's hidden cards)
 * would answer for the list as it stands. It updates from the appends and
 * in-place patches the store makes, so these tests drive it through a real
 * store and check it against a from-scratch build after every step.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as solid from "solid-js";
import * as solidStore from "solid-js/store";
import type { ChatItem, ToolItem } from "../../state";
import { hiddenWhileActivitiesOpen } from "../../chat/activity-cards";
import { indexToolRuns } from "../../chat/tool-runs";
import { buildTurnMeta } from "../../chat/turn-usage";
import { buildWaitRuns, type WaitRun } from "../../chat/wait-runs";
import type * as IndexModule from "../../chat/transcript-index";

// bun resolves "solid-js" and its store to the SSR builds, where nothing notifies; the client builds give the
// index live signals. Same technique as activities/keyed-rows.test.ts: mock them for this suite, restore after.
const CLIENT_SOLID: string = "solid-js/dist/solid.js";
const CLIENT_STORE: string = "solid-js/store/dist/store.js";
const originalSolid = { ...solid };
const originalStore = { ...solidStore };

let clientSolid: typeof solid;
let clientStore: typeof solidStore;
let createTranscriptIndex: typeof IndexModule.createTranscriptIndex;
let isRunMember: typeof IndexModule.isRunMember;

beforeAll(async () => {
	clientSolid = { ...(await import(CLIENT_SOLID)) };
	mock.module("solid-js", () => clientSolid);
	clientStore = { ...(await import(CLIENT_STORE)) };
	mock.module("solid-js/store", () => clientStore);
	const indexPath: string = "../../chat/transcript-index.ts?fresh=transcript-index-test";
	({ createTranscriptIndex, isRunMember } = await import(indexPath));
});

afterAll(() => {
	mock.module("solid-js", () => originalSolid);
	mock.module("solid-js/store", () => originalStore);
});

let nextId = 1;
const user = (timestamp = 1000): ChatItem => ({
	kind: "user",
	id: nextId++,
	text: "go",
	timestamp,
});
const assistant = (over: Partial<Extract<ChatItem, { kind: "assistant" }>> = {}): ChatItem => ({
	kind: "assistant",
	id: nextId++,
	blocks: [],
	...over,
});
const thinking = (): ChatItem => assistant({ blocks: [{ kind: "thinking", text: "hm" }] });
const prose = (): ChatItem => assistant({ blocks: [{ kind: "text", text: "done" }] });
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

type Options = IndexModule.TranscriptIndexOptions;
const OPTIONS: Options = {
	consolidated: true,
	hideToolActivity: false,
	hideActivityCards: false,
	hideThinking: false,
	proseOnlyThinking: true,
	showTokenUsage: false,
	turnTime: false,
	cacheMiss: false,
};

/** What a from-scratch build of the list says each tool, wait and assistant item is. */
function expected(items: readonly ChatItem[], options: Options) {
	const meta = buildTurnMeta(items, { turnTime: options.turnTime, cacheMiss: options.cacheMiss });
	const waits: ReadonlyMap<number, WaitRun> = options.hideToolActivity
		? new Map()
		: buildWaitRuns(items, {
				hideThinking: options.hideThinking,
				proseOnlyThinking: options.proseOnlyThinking,
				showTokenUsage: options.showTokenUsage,
				turnMeta: meta,
			});
	const drawn = options.hideActivityCards
		? items.filter((item) => !hiddenWhileActivitiesOpen(item))
		: items;
	const runs = indexToolRuns(drawn, {
		consolidated: options.consolidated,
		hideToolActivity: options.hideToolActivity,
		waitRuns: waits,
	});
	return { meta, waits, runs, drawn };
}

/** The index's answers for every item, in the shape of the expected build. */
function expectMatches(
	index: IndexModule.TranscriptIndex,
	items: readonly ChatItem[],
	options: Options,
) {
	const want = expected(items, options);
	for (const item of items) {
		if (item.kind === "assistant") {
			expect(index.consumed(item.id)).toBe(want.runs.consumedAssistantIds.has(item.id));
			expect(index.turnMeta(item.id)).toEqual(want.meta.get(item.id));
		}
		if (item.kind !== "tool") continue;
		expect(index.hidden(item.id)).toBe(
			options.hideActivityCards && hiddenWhileActivitiesOpen(item),
		);
		const run = want.runs.runOf.get(item.id);
		const slot = index.toolSlot(item.id);
		if (run === undefined) expect(slot).toBeUndefined();
		else if (run.key !== item.id) expect(slot).toEqual({ lead: run.key });
		else {
			expect(slot !== undefined && !isRunMember(slot)).toBe(true);
			if (slot === undefined || isRunMember(slot)) continue;
			expect(slot.key).toBe(run.key);
			expect(slot.tools.map((t) => t.id)).toEqual(run.tools.map((t) => t.id));
			expect(slot.thinking).toEqual(run.thinking);
			expect(slot.consumedAssistantIds).toEqual(run.consumedAssistantIds);
			expect(slot.running).toBe(run.running);
			expect(slot.errorCount).toBe(run.errorCount);
			expect(slot.requestCount).toBe(run.requestCount);
			expect(slot.turnCount).toBe(run.turnCount);
		}
		const wait = want.waits.get(item.id);
		const waitSlot = index.waitSlot(item.id);
		if (wait === undefined) expect(waitSlot).toBeUndefined();
		else if (wait.items[0]!.id !== item.id) expect(waitSlot).toEqual({ lead: wait.items[0]!.id });
		else {
			expect(waitSlot !== undefined && !isRunMember(waitSlot)).toBe(true);
			if (waitSlot === undefined || isRunMember(waitSlot)) continue;
			expect(waitSlot.items.map((t) => t.id)).toEqual(wait.items.map((t) => t.id));
		}
	}
}

const background = {
	jobId: "j1",
	type: "bash",
	state: "running" as const,
	jobIds: ["j1"],
	startedAt: 0,
};

describe("createTranscriptIndex", () => {
	test("follows appends and in-place patches of a streaming agentic transcript", () => {
		clientSolid.createRoot((dispose) => {
			const [state, setState] = clientStore.createStore<{ items: ChatItem[] }>({ items: [] });
			const [options, setOptions] = clientSolid.createSignal<Options>({
				...OPTIONS,
				showTokenUsage: true,
				turnTime: true,
			});
			const index = createTranscriptIndex(() => state.items, options);
			const push = (item: ChatItem) => {
				setState("items", state.items.length, item);
				expectMatches(index, state.items, options());
			};
			// Patches one field of an item in place, as the store's tool updates do.
			const set = setState as (...path: unknown[]) => void;
			const patch = (at: number, field: "status" | "background", value: unknown) => {
				set("items", at, field, value);
				expectMatches(index, state.items, options());
			};

			const calls = [tool("read"), tool("bash"), tool("wait"), tool("wait"), tool("edit")];
			push(user());
			push(thinking());
			push(calls[0]!);
			push(thinking());
			push(calls[1]!);
			push(calls[2]!);
			push(assistant());
			push(calls[3]!);
			push(prose());
			push(calls[4]!);
			// Calls settle one by one, a wait run's first call among them.
			for (const [i, item] of state.items.entries()) {
				if (item.kind === "tool") patch(i, "status", i % 4 === 0 ? "error" : "done");
			}
			patch(
				state.items.findIndex((it) => it.id === calls[1]!.id),
				"background",
				background,
			);
			push(user(5000));
			push(
				assistant({
					blocks: [{ kind: "text", text: "x" }],
					completedAt: 9000,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 5000,
						cacheWrite: 0,
						totalTokens: 5002,
					},
				}),
			);

			// Display settings recompute the same answers a from-scratch build gives.
			for (const change of [
				{ consolidated: false },
				{ consolidated: true, hideActivityCards: true },
				{ hideActivityCards: false, hideToolActivity: true },
				{ hideToolActivity: false, hideThinking: true },
				{ hideThinking: false },
			] as Partial<Options>[]) {
				setOptions((was) => ({ ...was, ...change }));
				expectMatches(index, state.items, options());
			}
			dispose();
		});
	});

	test("a replaced list is answered afresh, a wholesale rebuild included", () => {
		clientSolid.createRoot((dispose) => {
			const [state, setState] = clientStore.createStore<{ items: ChatItem[] }>({ items: [] });
			const index = createTranscriptIndex(
				() => state.items,
				() => OPTIONS,
			);
			setState("items", [user(), thinking(), tool("read", { status: "done" }), tool("bash")]);
			expectMatches(index, state.items, OPTIONS);
			setState("items", [tool("grep", { status: "done" }), tool("bash", { status: "done" })]);
			expectMatches(index, state.items, OPTIONS);
			setState("items", []);
			expectMatches(index, state.items, OPTIONS);
			dispose();
		});
	});

	test("finds the card that started a job once its result lands", () => {
		clientSolid.createRoot((dispose) => {
			const [state, setState] = clientStore.createStore<{ items: ChatItem[] }>({ items: [] });
			const index = createTranscriptIndex(
				() => state.items,
				() => OPTIONS,
			);
			const bash = tool("bash");
			setState("items", [user(), bash]);
			const seen: (ToolItem | undefined)[] = [];
			clientSolid.createComputed(() => seen.push(index.originOf("bg_1")));
			expect(seen).toEqual([undefined]);
			(setState as (...path: unknown[]) => void)("items", 1, "details", {
				async: { state: "running", jobId: "bg_1" },
			});
			expect(seen.at(-1)?.id).toBe(bash.id);
			dispose();
		});
	});
});
