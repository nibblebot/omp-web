/**
 * What the composer tells the session about a next-message prediction: it was shown (once per
 * prediction, however often the ghost comes and goes) and which alternative an insert took.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as solid from "solid-js";
import * as solidStore from "solid-js/store";
import * as stateModule from "../../state";
import * as settingsModule from "../../store/settings";
import type * as GhostModule from "../../components/chat/composer/useGhostText";
import { flushMicrotasks } from "../web.testkit";

// bun resolves "solid-js" to its SSR build, where effects never run; the client builds give the hook
// live reactivity. Same technique as chat/transcript-window.test.ts. `state`, `call` and the settings
// reader are stand-ins the hook reads, so the test sees exactly the calls it makes.
const CLIENT_SOLID: string = "solid-js/dist/solid.js";
const CLIENT_STORE: string = "solid-js/store/dist/store.js";
const originalSolid = { ...solid };
const originalStore = { ...solidStore };
const originalState = { ...stateModule };
const originalSettings = { ...settingsModule };

let clientSolid: typeof solid;
let useGhostText: typeof GhostModule.useGhostText;
let setStreaming: (streaming: boolean) => void;
let savedWindow: PropertyDescriptor | undefined;
let savedFrame: PropertyDescriptor | undefined;

interface Call {
	method: string;
	args: unknown[];
}
const calls: Call[] = [];
let nextReply: unknown;
const settings: Record<string, unknown> = {};

const callsTo = (method: string): unknown[][] =>
	calls.filter((c) => c.method === method).map((c) => c.args);

beforeAll(async () => {
	clientSolid = { ...(await import(CLIENT_SOLID)) };
	mock.module("solid-js", () => clientSolid);
	const clientStore = { ...(await import(CLIENT_STORE)) };
	mock.module("solid-js/store", () => clientStore);
	const [fakeState, setFakeState] = clientStore.createStore({
		streaming: false,
		currentWorkspaceId: "w1",
		sessionId: "s1",
	});
	setStreaming = (streaming) => setFakeState("streaming", streaming);
	mock.module("../../state", () => ({
		...originalState,
		state: fakeState,
		call: async (method: string, args: unknown[] = []) => {
			calls.push({ method, args });
			return method === "predictNextMessage" ? nextReply : {};
		},
	}));
	mock.module("../../store/settings", () => ({
		...originalSettings,
		settingValue: (path: string) => settings[path],
	}));
	savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	savedFrame = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
	Reflect.set(globalThis, "window", globalThis);
	Reflect.set(globalThis, "requestAnimationFrame", () => 0);
	// A dynamic import: the hook must load after the solid-js and state mocks above, which a static
	// import cannot order; the query string bypasses the cached SSR-bound copy.
	const hookPath: string = "../../components/chat/composer/useGhostText.ts?fresh=ghost-prediction";
	({ useGhostText } = await import(hookPath));
});

afterAll(() => {
	mock.module("../../store/settings", () => originalSettings);
	mock.module("../../state", () => originalState);
	mock.module("solid-js/store", () => originalStore);
	mock.module("solid-js", () => originalSolid);
	for (const [key, saved] of [
		["window", savedWindow],
		["requestAnimationFrame", savedFrame],
	] as const) {
		if (saved) Object.defineProperty(globalThis, key, saved);
		else Reflect.deleteProperty(globalThis, key);
	}
});

beforeEach(() => {
	calls.length = 0;
	setStreaming(false);
	settings["composer.predictions"] = true;
	settings["spelling.autocomplete"] = "off";
});

/** A composer's ghost text over an empty draft. */
function mount() {
	return clientSolid.createRoot((dispose) => {
		const [message, setMessage] = clientSolid.createSignal("");
		const ghost = useGhostText(() => undefined, message, setMessage);
		return { ghost, message, setMessage, dispose };
	});
}

/** Lets the hook's `call(...).then(...)` run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 3; i++) await flushMicrotasks();
}

/** A streamed turn ends, and the session answers the prediction request with `reply`. */
async function endTurn(reply: unknown): Promise<void> {
	nextReply = reply;
	setStreaming(true);
	setStreaming(false);
	await settle();
}

const THREE = {
	text: "Run the tests",
	choices: ["Run the tests", "Commit the change", "Open a PR"],
};

describe("prediction shown", () => {
	test("is reported once per prediction, however often the ghost comes and goes", async () => {
		const view = mount();
		await endTurn(THREE);
		expect(view.ghost.text()).toBe("Run the tests");
		expect(callsTo("predictionShown")).toEqual([[]]);

		view.setMessage("Run");
		view.setMessage("Run the");
		view.setMessage("x");
		view.setMessage("");
		expect(view.ghost.text()).toBe("Run the tests");
		expect(callsTo("predictionShown")).toHaveLength(1);

		await endTurn({ text: "Open the PR" });
		expect(view.ghost.text()).toBe("Open the PR");
		expect(callsTo("predictionShown")).toHaveLength(2);
		view.dispose();
	});

	test("the `more` hint over a draft equal to an alternative counts as shown", async () => {
		const view = mount();
		await endTurn(THREE);
		// Typing the whole of a later alternative leaves no ghost, only the hint.
		view.setMessage("Commit the change");
		expect(view.ghost.hint()).toBe("⇥ 2 more");
		expect(callsTo("predictionShown")).toHaveLength(1);
		view.dispose();
	});

	test("is not reported when the model offered nothing", async () => {
		const view = mount();
		await endTurn({ text: null });
		view.setMessage("Run");
		expect(callsTo("predictionShown")).toEqual([]);
		view.dispose();
	});

	test("is not reported for a prediction a new turn retired before its answer arrived", async () => {
		const view = mount();
		nextReply = THREE;
		setStreaming(true);
		setStreaming(false);
		// The next turn starts before the answer is read.
		setStreaming(true);
		await settle();
		expect(view.ghost.text()).toBe("");
		expect(callsTo("predictionShown")).toEqual([]);
		view.dispose();
	});
});

describe("prediction accepted", () => {
	test("Tab over the ghost carries the rank of the prediction the draft follows", async () => {
		const view = mount();
		await endTurn(THREE);
		view.setMessage("Commit");
		expect(view.ghost.accept()).toBe(true);
		expect(view.message()).toBe("Commit the change");
		expect(callsTo("predictionAccepted")).toEqual([[1]]);
		view.dispose();
	});

	test("the first prediction is rank 0", async () => {
		const view = mount();
		await endTurn(THREE);
		expect(view.ghost.accept()).toBe(true);
		expect(callsTo("predictionAccepted")).toEqual([[0]]);
		view.dispose();
	});

	test("the list reports the alternative it inserted, and a pick that changes nothing reports none", async () => {
		const view = mount();
		await endTurn(THREE);
		view.setMessage("Run the tests");
		expect(view.ghost.openAlternatives()).toBe(true);
		view.ghost.alternatives.choose(0);
		expect(callsTo("predictionAccepted")).toEqual([]);

		expect(view.ghost.openAlternatives()).toBe(true);
		view.ghost.alternatives.choose(2);
		expect(view.message()).toBe("Open a PR");
		expect(callsTo("predictionAccepted")).toEqual([[2]]);
		view.dispose();
	});

	test("a draft no prediction follows reports nothing", async () => {
		const view = mount();
		await endTurn(THREE);
		view.setMessage("typed");
		expect(view.ghost.accept()).toBe(false);
		expect(callsTo("predictionAccepted")).toEqual([]);
		view.dispose();
	});
});
