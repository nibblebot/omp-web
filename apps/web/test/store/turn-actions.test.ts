/**
 * A transcript turn's Edit & resend and Retry turn (store/graph.ts `runTurnAction`): the rewind
 * names the turn by role and timestamp, Edit puts the prompt in the composer in place of its
 * draft and toasts an Undo that returns to the previous leaf and draft, and Retry resends at
 * once but never over an unsent draft.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ClientCommand } from "#lib/wire/protocol";
import { connect, promptInsert, setPromptInsert, setState, state } from "../../state";
import { registerComposerContent, type ComposerContent } from "../../store/drafts";
import { runTurnAction } from "../../store/graph";
import { rejectPendingCalls } from "../../store/transport";
import {
	FakeWebSocket,
	callResult,
	dispatch,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "../web.testkit";

function callsTo(method: string): Extract<ClientCommand, { type: "call" }>[] {
	return posted.filter(
		(c): c is Extract<ClientCommand, { type: "call" }> => c.type === "call" && c.method === method,
	);
}

/** Answer the one pending call to `method`. */
async function answer(method: string, data: unknown): Promise<unknown[]> {
	await flushMicrotasks();
	const [cmd] = callsTo(method);
	expect(cmd).toBeDefined();
	dispatch(callResult(cmd!.id, data));
	await flushMicrotasks();
	return cmd!.args ?? [];
}

const turn = { role: "user" as const, at: 1000 };
const rewound = {
	revision: "rev-after",
	editorText: "first question",
	entryId: "u1",
	previousLeafId: "a2",
	rewoundTurns: 2,
};

let draft: ComposerContent;
let unregister: () => void;

beforeEach(() => {
	installTransportStubs();
	connect();
	FakeWebSocket.instances.at(-1)!.onopen?.();
	posted.length = 0;
	setState({
		streaming: false,
		readyAt: 1,
		toasts: [],
		currentWorkspaceId: "ws1",
		sessionId: "sess1",
	});
	setPromptInsert(null);
	draft = { text: "", images: [], files: [] };
	unregister = registerComposerContent(() => draft);
});

afterEach(() => {
	unregister();
	setPromptInsert(null);
	setState({ toasts: [], readyAt: undefined });
	rejectPendingCalls(new Error("test teardown"));
	restoreBrowserGlobals();
});

describe("turn actions", () => {
	test("Edit & resend replaces the draft; Undo returns to the previous leaf and draft", async () => {
		draft = { text: "half typed", images: [], files: [] };
		const done = runTurnAction("edit", turn);
		expect(await answer("rewindTurn", rewound)).toEqual([turn]);
		await done;
		expect(promptInsert()).toEqual({ text: "first question", replace: true });
		const toast = state.toasts.at(-1);
		expect(toast?.text).toBe("Rewound 2 turns");
		expect(toast?.action?.label).toBe("Undo");

		setPromptInsert(null);
		posted.length = 0;
		toast!.action!.run();
		await answer("getSessionGraph", {
			sessionId: "sess1",
			revision: "rev-now",
			leafId: "u0",
			nodes: [],
			hasMore: false,
			nextCursor: null,
		});
		expect(await answer("navigateTree", { revision: "rev-undone" })).toEqual([
			"a2",
			{ revision: "rev-now" },
		]);
		expect(promptInsert()).toEqual({ text: "half typed", images: [], files: [], replace: true });
		expect(state.toasts.at(-1)?.text).toBe("Rewind undone");
	});

	test("a rewind that drops no turn says so", async () => {
		const done = runTurnAction("edit", turn);
		await answer("rewindTurn", { ...rewound, rewoundTurns: 0 });
		await done;
		expect(state.toasts.at(-1)?.text).toBe("Rewound to selected point");
	});

	test("Retry turn sends the prompt again at once, without an Undo", async () => {
		const done = runTurnAction("retry", turn);
		await answer("rewindTurn", rewound);
		await done;
		await flushMicrotasks();
		// The posted command is JSON: an absent image list goes out as null.
		expect(callsTo("prompt").map((c) => c.args)).toEqual([["first question", null]]);
		expect(promptInsert()).toBeNull();
		expect(state.toasts.at(-1)).toEqual({ id: expect.any(Number), text: "Retrying the turn" });
	});

	test("Retry turn refuses over an unsent draft and moves nothing", async () => {
		draft = { text: "not sent yet", images: [], files: [] };
		await runTurnAction("retry", turn);
		await flushMicrotasks();
		expect(callsTo("rewindTurn")).toEqual([]);
		expect(state.toasts.at(-1)?.text).toBe("Send or clear the draft to retry this turn");
	});

	test("a turn action waits for the running response", async () => {
		setState({ streaming: true });
		await runTurnAction("edit", turn);
		await flushMicrotasks();
		expect(callsTo("rewindTurn")).toEqual([]);
		expect(state.toasts.at(-1)?.text).toBe(
			"Wait for the current response to finish or stop it first.",
		);
	});
});
