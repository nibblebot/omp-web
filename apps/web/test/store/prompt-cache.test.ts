/**
 * The composer's prompt-cache indicator state: what a read stores, when it hides, when the store reads
 * again (attach, turn end, compaction, popover-less expiry flip) and that a stale answer never shows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PromptCacheStatusDto, PromptCacheStatusReply } from "#lib/wire/protocol";
import * as solid from "solid-js";
import * as solidStore from "solid-js/store";
import * as clockModule from "../../activities/clock";
import * as stateModule from "../../state";
import * as transportModule from "../../store/transport";
import type * as StoreModule from "../../store/prompt-cache";
import { flushMicrotasks } from "../web.testkit";

// bun resolves "solid-js" to its SSR build, where effects never run; the client builds give the watchers
// live reactivity (same technique as chat/ghost-text-prediction.test.ts). `state`, `call` and the clock are
// stand-ins, so the test sees exactly the calls the store makes and moves time by hand.
const CLIENT_SOLID: string = "solid-js/dist/solid.js";
const CLIENT_STORE: string = "solid-js/store/dist/store.js";
const originalSolid = { ...solid };
const originalStore = { ...solidStore };
const originalState = { ...stateModule };
const originalTransport = { ...transportModule };
const originalClock = { ...clockModule };

let clientSolid: typeof solid;
let store: typeof StoreModule;
let setFake: (patch: Record<string, unknown>) => void;
let setNow: (ms: number) => void;

const calls: Array<{ method: string; args: unknown[] }> = [];
let reply: (() => Promise<unknown>) | (() => unknown) = () => ({ status: null });

const NOW = 1_000_000;
const warm = (over: Partial<PromptCacheStatusDto> = {}): PromptCacheStatusDto => ({
	state: "warm",
	inferred: false,
	tier: "short",
	touchedAt: NOW - 60_000,
	ttlMs: 300_000,
	cachedTokens: 48_000,
	nextTokens: 52_000,
	...over,
});
const replyFor = (status: PromptCacheStatusDto): PromptCacheStatusReply => ({
	status,
	brief: ["Cached until later", "Next message reads ~48,000 from cache"],
	details: [{ label: "State", value: "Cached" }],
});
const answerWith = (value: unknown) => {
	reply = () => value;
};
const settle = async () => {
	for (let i = 0; i < 6; i++) await flushMicrotasks();
};
const callsTo = (method: string) => calls.filter((c) => c.method === method).length;

beforeAll(async () => {
	clientSolid = { ...(await import(CLIENT_SOLID)) };
	mock.module("solid-js", () => clientSolid);
	const clientStore: typeof solidStore = { ...(await import(CLIENT_STORE)) };
	mock.module("solid-js/store", () => clientStore);
	const [fakeState, setFakeState] = clientStore.createStore<Record<string, unknown>>({
		connected: true,
		currentWorkspaceId: "ws-a",
		sessionId: "s1",
		readyAt: 1,
		streaming: false,
		compacting: false,
	});
	setFake = (patch) => setFakeState(patch);
	const [now, setNowSignal] = clientSolid.createSignal(NOW);
	setNow = (ms) => setNowSignal(ms);
	mock.module("../../state", () => ({
		...originalState,
		state: fakeState,
		isReady: () => fakeState.readyAt !== undefined,
	}));
	mock.module("../../store/transport", () => ({
		...originalTransport,
		call: async (method: string, args: unknown[] = []) => {
			calls.push({ method, args });
			return await reply();
		},
	}));
	mock.module("../../activities/clock", () => ({ createNow: () => now }));
	const path: string = "../../store/prompt-cache.ts?fresh=prompt-cache";
	store = await import(path);
});

afterAll(() => {
	mock.module("../../activities/clock", () => originalClock);
	mock.module("../../store/transport", () => originalTransport);
	mock.module("../../state", () => originalState);
	mock.module("solid-js/store", () => originalStore);
	mock.module("solid-js", () => originalSolid);
});

beforeEach(() => {
	calls.length = 0;
	setNow(NOW);
	setFake({
		connected: true,
		currentWorkspaceId: "ws-a",
		sessionId: "s1",
		readyAt: 1,
		streaming: false,
		compacting: false,
	});
	store.clearPromptCache();
	answerWith({ status: null });
});

describe("refreshPromptCache", () => {
	test("keeps the status with the session's own brief and detail rows", async () => {
		expect(store.promptCacheView()).toBeNull();
		answerWith(replyFor(warm()));
		await store.refreshPromptCache();
		expect(calls).toEqual([{ method: "getPromptCacheStatus", args: [] }]);
		const shown = store.promptCacheView();
		expect(shown?.status.state).toBe("warm");
		expect(shown?.brief).toEqual(["Cached until later", "Next message reads ~48,000 from cache"]);
		expect(shown?.details).toEqual([{ label: "State", value: "Cached" }]);
	});

	test("hides on a null status", async () => {
		answerWith(replyFor(warm()));
		await store.refreshPromptCache();
		expect(store.promptCacheView()).not.toBeNull();
		answerWith({ status: null });
		await store.refreshPromptCache();
		expect(store.promptCacheView()).toBeNull();
	});

	test("hides silently when the session predates the method", async () => {
		answerWith(replyFor(warm()));
		await store.refreshPromptCache();
		reply = () => Promise.reject(new Error("Unknown method: getPromptCacheStatus"));
		await store.refreshPromptCache();
		expect(store.promptCacheView()).toBeNull();
	});

	test("an offline or superseded read keeps what was shown", async () => {
		answerWith(replyFor(warm()));
		await store.refreshPromptCache();
		reply = () => Promise.reject(new Error("session switched"));
		await store.refreshPromptCache();
		expect(store.promptCacheView()).not.toBeNull();
		setFake({ connected: false });
		await store.refreshPromptCache();
		expect(callsTo("getPromptCacheStatus")).toBe(2);
		expect(store.promptCacheView()).not.toBeNull();
	});

	test("drops an answer for a session the tab left meanwhile", async () => {
		const held = Promise.withResolvers<unknown>();
		reply = () => held.promise;
		const pending = store.refreshPromptCache();
		setFake({ sessionId: "s2" });
		held.resolve(replyFor(warm()));
		await pending;
		expect(store.promptCacheView()).toBeNull();
	});

	test("a view of another attachment is never shown", async () => {
		answerWith(replyFor(warm()));
		await store.refreshPromptCache();
		setFake({ currentWorkspaceId: "ws-b" });
		expect(store.promptCacheView()).toBeNull();
	});

	test("asks once at a time and once more when asked during a read", async () => {
		const first = Promise.withResolvers<unknown>();
		let n = 0;
		reply = () => (n++ === 0 ? first.promise : replyFor(warm({ cachedTokens: 1 })));
		const a = store.refreshPromptCache();
		void store.refreshPromptCache();
		void store.refreshPromptCache();
		expect(callsTo("getPromptCacheStatus")).toBe(1);
		first.resolve(replyFor(warm()));
		await a;
		expect(callsTo("getPromptCacheStatus")).toBe(2);
		expect(store.promptCacheView()?.status.cachedTokens).toBe(1);
	});
});

describe("watchPromptCache", () => {
	const mount = () =>
		clientSolid.createRoot((dispose) => {
			store.watchPromptCache();
			return dispose;
		});

	test("reads on attach, after a turn ends and after a compaction ends", async () => {
		answerWith(replyFor(warm()));
		const dispose = mount();
		await settle();
		expect(callsTo("getPromptCacheStatus")).toBe(1);
		expect(store.promptCacheView()).not.toBeNull();

		setFake({ streaming: true });
		await settle();
		expect(callsTo("getPromptCacheStatus")).toBe(1);
		setFake({ streaming: false });
		await settle();
		expect(callsTo("getPromptCacheStatus")).toBe(2);

		setFake({ compacting: true });
		await settle();
		setFake({ compacting: false });
		await settle();
		expect(callsTo("getPromptCacheStatus")).toBe(3);
		dispose();
	});

	test("a session switch forgets the old read and reads the new session", async () => {
		answerWith(replyFor(warm()));
		const dispose = mount();
		await settle();
		answerWith({ status: null });
		setFake({ sessionId: "s2" });
		await settle();
		expect(callsTo("getPromptCacheStatus")).toBe(2);
		expect(store.promptCacheView()).toBeNull();
		dispose();
	});

	test("waits for a ready session", async () => {
		setFake({ readyAt: undefined });
		const dispose = mount();
		await settle();
		expect(callsTo("getPromptCacheStatus")).toBe(0);
		setFake({ readyAt: 2 });
		await settle();
		expect(callsTo("getPromptCacheStatus")).toBe(1);
		dispose();
	});
});

describe("createPromptCacheIndicator", () => {
	const mount = () =>
		clientSolid.createRoot((dispose) => ({
			indicator: store.createPromptCacheIndicator(),
			dispose,
		}));

	test("flips warm to cold when touchedAt + ttlMs passes, and asks the session again", async () => {
		answerWith(replyFor(warm()));
		await store.refreshPromptCache();
		calls.length = 0;
		const { indicator, dispose } = mount();
		expect(indicator()).toEqual({ tone: "warm", label: "warm", expired: false });

		// The session reports cold at the next read (the warm refresh did not keep it).
		answerWith(replyFor(warm({ state: "cold", reason: { kind: "expired", at: NOW + 240_000 } })));
		setNow(NOW + 239_999);
		await settle();
		expect(indicator()?.tone).toBe("warm");
		expect(calls).toHaveLength(0);

		setNow(NOW + 240_000);
		await settle();
		expect(indicator()).toEqual({ tone: "cold", label: "cold", expired: false });
		expect(callsTo("getPromptCacheStatus")).toBe(1);
		dispose();
	});

	test("a lapse the session denies (its warm refresh held the entry) shows warm again", async () => {
		answerWith(replyFor(warm()));
		await store.refreshPromptCache();
		const { indicator, dispose } = mount();
		answerWith(replyFor(warm({ touchedAt: NOW + 239_000 })));
		setNow(NOW + 241_000);
		await settle();
		expect(callsTo("getPromptCacheStatus")).toBe(2);
		expect(indicator()?.tone).toBe("warm");
		dispose();
	});

	test("is undefined while hidden", async () => {
		const { indicator, dispose } = mount();
		expect(indicator()).toBeUndefined();
		dispose();
	});
});
