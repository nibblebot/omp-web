/**
 * The tab holds its own sends while a session-replacing call (newSession,
 * switchSession, ...) is pending.
 *
 * The SDK mints the new session id partway through such a call, and the
 * daemon answers only after the history and state resync. Until then the
 * `sessionScope` the tab stamps on every call is the OLD session's, so a prompt
 * sent in that gap is rejected "Stale session attachment" (or, when it lands
 * before the id flips, runs on the session that is being torn down and is
 * wiped by the resync). The composer must not offer a send until the answer,
 * and with it the new session's state frame, has landed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createComponent } from "solid-js";
import * as solidWeb from "solid-js/web";
import { SESSION_REPLACING_METHODS } from "#lib/wire/protocol";
import type { ServerFrame, WebMethodName } from "#lib/wire/protocol";
import { PromptActions } from "../components/chat/composer/PromptActions";
import { connect, setState, state } from "../state";
import { isSessionChanging } from "../store/session";
import { call, rejectPendingCalls } from "../store/transport";
import {
	attached,
	dispatch,
	FakeWebSocket,
	installJsxShim,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	restoreJsxShim,
	setBrowserGlobal,
} from "./web.testkit";

type CallResult = Extract<ServerFrame, { type: "call_result" }>;

function scopeOf(sessionId: string) {
	return { workspaceId: "ws", generation: "1", sessionId };
}

function stateFrame(sessionId: string): ServerFrame {
	return {
		type: "state",
		state: { sessionId, sessionScope: scopeOf(sessionId), isStreaming: false },
	} as unknown as ServerFrame;
}

/** The call command most recently posted for `method`. */
function lastCall(method: WebMethodName): Extract<(typeof posted)[number], { type: "call" }> {
	const found = posted.filter((c) => c.type === "call" && c.method === method).at(-1);
	if (found?.type !== "call") throw new Error(`no ${method} call posted`);
	return found;
}

function answer(id: string, ok = true, error?: string): CallResult {
	return { type: "call_result", id, ok, data: { cancelled: false }, ...(error ? { error } : {}) };
}

function sendButton(): string {
	const html = solidWeb.renderToString(() =>
		createComponent(PromptActions, {
			message: () => "Reply with the single word X.",
			images: () => [],
			files: () => [],
			submit: () => {},
		}),
	);
	const button = /<button[^>]*aria-label="Send"[^>]*>/.exec(html);
	if (button === null) throw new Error("send button not rendered");
	return button[0];
}

beforeEach(() => {
	installTransportStubs();
	installJsxShim();
	connect();
	FakeWebSocket.instances.at(-1)!.onopen?.();
	dispatch(attached("d1"));
	dispatch(stateFrame("s1"));
	setState("readyAt", 123);
});

afterEach(() => {
	rejectPendingCalls(new Error("test reset"));
	setState({
		connected: false,
		sessionDownId: "",
		currentSessionId: "",
		sessionScope: undefined,
		readyAt: undefined,
	});
});

afterAll(() => {
	restoreJsxShim();
	restoreBrowserGlobals();
});

describe("session change gate", () => {
	test("the composer cannot send between New session and the new session's identity", async () => {
		expect(isSessionChanging()).toBe(false);
		expect(sendButton()).not.toMatch(/\bdisabled\b/);

		const started = call("newSession");
		// The daemon's SDK has minted s2 by now; this tab still holds s1.
		expect(state.sessionScope?.sessionId).toBe("s1");
		expect(isSessionChanging()).toBe(true);
		expect(sendButton()).toMatch(/\bdisabled\b/);

		// A call that slips through here carries the old identity: the guard's
		// "Stale session attachment" case. The gate exists so the composer never
		// produces it.
		void call("prompt", ["Reply with the single word X."]).catch(() => {});
		expect(lastCall("prompt").scope?.sessionId).toBe("s1");

		// The daemon resyncs before answering: state frame first, then the answer.
		dispatch(stateFrame("s2"));
		expect(isSessionChanging()).toBe(true);
		dispatch(answer(lastCall("newSession").id));
		await started;
		expect(state.sessionScope?.sessionId).toBe("s2");
		expect(isSessionChanging()).toBe(false);
		expect(sendButton()).not.toMatch(/\bdisabled\b/);
	});

	test.each([...SESSION_REPLACING_METHODS])(
		"%s holds the composer until it settles",
		async (method) => {
			const started = call(method).catch(() => {});
			expect(isSessionChanging()).toBe(true);
			dispatch(answer(lastCall(method).id));
			await started;
			expect(isSessionChanging()).toBe(false);
		},
	);

	test("an ordinary call never holds the composer", () => {
		void call("prompt", ["hi"]).catch(() => {});
		void call("getSubagents").catch(() => {});
		expect(isSessionChanging()).toBe(false);
	});

	test("a refused change releases the composer", async () => {
		const started = call("newSession").catch((err: Error) => err.message);
		expect(isSessionChanging()).toBe(true);
		dispatch(
			answer(
				lastCall("newSession").id,
				false,
				"Another session lifecycle operation is in progress",
			),
		);
		expect(await started).toBe("Another session lifecycle operation is in progress");
		expect(isSessionChanging()).toBe(false);
	});

	test("a change swept by a session switch releases the composer", async () => {
		const started = call("newSession").catch((err: Error) => err.message);
		expect(isSessionChanging()).toBe(true);
		dispatch(attached("d2"));
		expect(await started).toBe("session switched");
		expect(isSessionChanging()).toBe(false);
	});

	test("a change that times out releases the composer", async () => {
		// Capture the call's deadline timer and fire it by hand: no wall clock.
		const deadlines: Array<() => void> = [];
		setBrowserGlobal("window", {
			setTimeout: (fn: () => void) => deadlines.push(fn),
		} as unknown as Window & typeof globalThis);
		const started = call("newSession", [], 5).catch((err: Error) => err.message);
		expect(isSessionChanging()).toBe(true);
		deadlines[0]!();
		expect(await started).toBe('call "newSession" timed out');
		expect(isSessionChanging()).toBe(false);
	});
});
