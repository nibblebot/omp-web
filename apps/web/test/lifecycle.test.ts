/**
 * Page-lifecycle resume of the browser socket (store/lifecycle.ts, state.ts):
 * a dead dial redials at once with the ladder reset, a silent socket is
 * replaced on resume, offline holds the dials, and a terminal refusal stays
 * terminal. The server is the FakeWebSocket from web.testkit.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test, vi } from "bun:test";
import { browserCloseFor } from "#lib/wire/browser-socket";
import { CLIENT_KEEPALIVE_MS } from "#lib/wire/protocol";
import { connect, resumeConnection, setState, state, suspendConnection } from "../state";
import { installLifecycle } from "../store/lifecycle";
import { rejectPendingCalls, sendCommand } from "../store/transport";
import {
	dispatchSeq,
	FakeWebSocket,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "./web.testkit";

function current(): FakeWebSocket {
	return FakeWebSocket.instances.at(-1)!;
}

function openSocket(): FakeWebSocket {
	connect();
	const ws = current();
	ws.onopen?.();
	return ws;
}

let online = true;
const onLineDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, "onLine");

beforeEach(() => {
	installTransportStubs();
	online = true;
	Object.defineProperty(globalThis.navigator, "onLine", { get: () => online, configurable: true });
	setState({ currentWorkspaceId: "", connected: false, transportStartup: true, error: null });
});

afterEach(() => {
	vi.useRealTimers();
	mock.restore();
	rejectPendingCalls(new Error("test teardown"));
});

afterAll(() => {
	if (onLineDescriptor === undefined) Reflect.deleteProperty(globalThis.navigator, "onLine");
	else Object.defineProperty(globalThis.navigator, "onLine", onLineDescriptor);
	restoreBrowserGlobals();
});

describe("resume after the socket died", () => {
	test("dials at once and resets the ladder instead of waiting out the backoff", () => {
		vi.useFakeTimers();
		const first = openSocket();
		first.serverClose(1006);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(state.reconnectDelay).toBeGreaterThan(0);

		resumeConnection();
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(state.reconnectDelay).toBe(0);
		// The cancelled backoff timer must not dial a third socket.
		vi.advanceTimersByTime(20_000);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	test("a failed dial after resume starts the ladder from its first rung again", () => {
		vi.useFakeTimers();
		for (let i = 0; i < 4; i++) {
			current()?.serverClose(1006);
			vi.advanceTimersByTime(60_000);
		}
		openSocket().serverClose(1006);
		resumeConnection();
		current().serverClose(1006); // the resumed dial fails: the delay is the first rung's
		expect(state.reconnectDelay).toBeLessThanOrEqual(2_000);
	});

	test("an unacked command is re-sent under its own id on the resumed socket", () => {
		vi.useFakeTimers();
		const first = openSocket();
		FakeWebSocket.autoAck = false;
		void sendCommand({ type: "stop", id: "cmd-resume", workspaceId: "d1" }).catch(() => {});
		first.serverClose(1006);
		resumeConnection();
		current().onopen?.();
		expect(posted.map((c) => c.id)).toEqual(["cmd-resume", "cmd-resume"]);
	});

	test("does not dial after a terminal refusal", () => {
		const ws = openSocket();
		const { code, reason } = browserCloseFor("forbidden", "origin refused");
		ws.serverClose(code, reason);
		resumeConnection();
		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});

describe("resume on a socket that looks open", () => {
	test("a socket silent for more than twice the keepalive is replaced, resuming with after", () => {
		let now = 1_000_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const ws = openSocket();
		dispatchSeq({ type: "command_echo", text: "x" }, 7);
		now += 2 * CLIENT_KEEPALIVE_MS + 1;
		resumeConnection();
		expect(ws.closed).not.toBeNull();
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(new URL(current().url).searchParams.get("after")).toBe("7");
	});

	test("a socket that delivered within twice the keepalive is left alone", () => {
		let now = 1_000_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const ws = openSocket();
		now += 2 * CLIENT_KEEPALIVE_MS - 1;
		resumeConnection();
		expect(ws.closed).toBeNull();
		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});

describe("offline", () => {
	test("drops the socket and cancels the pending retry; resume stays quiet until online", () => {
		vi.useFakeTimers();
		const ws = openSocket();
		suspendConnection();
		expect(ws.closed).not.toBeNull();
		expect(state.connected).toBe(false);

		online = false;
		resumeConnection(); // a foreground while offline
		vi.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);

		online = true;
		resumeConnection(); // the online event
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	test("cancels a backoff timer already armed when the browser reports offline", () => {
		vi.useFakeTimers();
		openSocket().serverClose(1006);
		suspendConnection();
		vi.advanceTimersByTime(60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});

describe("installLifecycle", () => {
	test("visible, bfcache restore and online resume; hidden and a plain pageshow do not; offline holds", () => {
		const doc = Object.assign(new EventTarget(), { visibilityState: "hidden" });
		const win = Object.assign(new EventTarget(), {
			setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
		});
		const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
		Object.defineProperty(globalThis, "document", {
			value: doc,
			configurable: true,
			writable: true,
		});
		setBrowserGlobal("window", win as unknown as Window & typeof globalThis);
		const remove = installLifecycle();
		try {
			openSocket().serverClose(1006);
			expect(FakeWebSocket.instances).toHaveLength(1);

			doc.dispatchEvent(new Event("visibilitychange")); // still hidden
			win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
			expect(FakeWebSocket.instances).toHaveLength(1);

			doc.visibilityState = "visible";
			doc.dispatchEvent(new Event("visibilitychange"));
			expect(FakeWebSocket.instances).toHaveLength(2);

			current().serverClose(1006);
			win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
			expect(FakeWebSocket.instances).toHaveLength(3);

			win.dispatchEvent(new Event("offline"));
			expect(current().closed).not.toBeNull();
			win.dispatchEvent(new Event("online"));
			expect(FakeWebSocket.instances).toHaveLength(4);
		} finally {
			remove();
			if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document");
			else Object.defineProperty(globalThis, "document", previousDocument);
		}
	});
});
