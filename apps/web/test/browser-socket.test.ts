/**
 * The web client's side of the browser socket (OMP_PROTO 5): the dial, the
 * reconnect ladder, resume with `after`, in-band command retry across a drop,
 * the typed close codes, and the silence deadline. The server is the
 * FakeWebSocket from web.testkit: each test plays the server's half.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test, vi } from "bun:test";
import { browserCloseFor } from "#lib/wire/browser-socket";
import { CLIENT_SILENCE_DEADLINE_MS, COMMAND_DEDUP_WINDOW_MS, OMP_PROTO } from "#lib/wire/protocol";
import { connect, initAuth, setState, state } from "../state";
import { signIn } from "../store/auth";
import {
	call,
	isConnected,
	pendingCalls,
	rejectPendingCalls,
	sendCommand,
} from "../store/transport";
import {
	attached,
	callResult,
	dispatch,
	dispatchSeq,
	FakeWebSocket,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
	setBrowserGlobal,
} from "./web.testkit";

/** The newest socket the client dialed. */
function current(): FakeWebSocket {
	return FakeWebSocket.instances.at(-1)!;
}

/** Dial and open a socket: `open` is what makes the client connected. */
function openSocket(): FakeWebSocket {
	connect();
	const ws = current();
	ws.onopen?.();
	return ws;
}

/** The server closes `ws` with a typed close, as the edge does. */
function closeTyped(
	ws: FakeWebSocket,
	kind: Parameters<typeof browserCloseFor>[0],
	message: string,
): void {
	const { code, reason } = browserCloseFor(kind, message);
	ws.serverClose(code, reason);
}

/** A notice frame the server pushes; each one adds exactly one transcript item. */
function echo(text: string) {
	return { type: "command_echo", text } as const;
}

function echoCount(text: string): number {
	return state.items.filter((it) => it.kind === "notice" && it.message === text).length;
}

beforeEach(() => {
	installTransportStubs();
	setState({
		currentSessionId: "",
		connected: false,
		transportStartup: true,
		lastFrameAt: 0,
		items: [],
		modal: null,
		error: null,
	});
});

afterEach(() => {
	vi.useRealTimers();
	// Calls a test left pending would be re-sent by the next test's reconnects.
	rejectPendingCalls(new Error("test teardown"));
});

/** Move the auth module to signedIn so a following 401/4401 is a real transition. */
async function signInStub(): Promise<void> {
	setBrowserGlobal(
		"fetch",
		(async () =>
			({
				ok: true,
				status: 200,
				headers: new Headers(),
				json: async () => ({ csrfToken: "csrf" }),
			}) as unknown as Response) as unknown as typeof fetch,
	);
	await signIn("access-token");
}

afterAll(() => restoreBrowserGlobals());

describe("dial", () => {
	test("dials /ws on the page origin with the client id and proto, and no resume point on a fresh page", () => {
		connect();
		const url = new URL(current().url);
		expect(url.protocol).toBe("ws:");
		expect(url.host).toBe("localhost");
		expect(url.pathname).toBe("/ws");
		expect(url.searchParams.get("client")).toBeTruthy();
		expect(url.searchParams.get("proto")).toBe(String(OMP_PROTO));
		expect(url.searchParams.has("after")).toBe(false);
		expect(url.searchParams.has("token")).toBe(false);
	});

	test("carries the page URL's bearer token in the query", () => {
		setBrowserGlobal("location", {
			search: "?token=s3cret",
			origin: "https://fleet.example",
		} as Location);
		connect();
		const url = new URL(current().url);
		expect(url.protocol).toBe("wss:");
		expect(url.searchParams.get("token")).toBe("s3cret");
	});

	test("open is connected: the strip's startup hold ends and commands flow", () => {
		connect();
		expect(state.connected).toBe(false);
		expect(isConnected()).toBe(false);
		current().onopen?.();
		expect(state.connected).toBe(true);
		expect(isConnected()).toBe(true);
		expect(state.transportStartup).toBe(false);
	});

	test("a first connection still pending after the startup grace shows the strip anyway", () => {
		vi.useFakeTimers();
		connect();
		vi.advanceTimersByTime(9_999);
		expect(state.transportStartup).toBe(true);
		vi.advanceTimersByTime(1);
		expect(state.transportStartup).toBe(false);
	});

	test("a socket event after the socket was superseded is ignored", () => {
		const first = openSocket();
		connect(); // a newer dial supersedes the first socket
		expect(first.closed).not.toBeNull();
		first.serverClose(1006);
		first.message(JSON.stringify({ frame: echo("late") }));
		expect(echoCount("late")).toBe(0);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});
});

describe("resume after a drop", () => {
	test("redials with after = the highest seq received; the replay overlap is applied once and no ringed delta is lost", () => {
		vi.useFakeTimers();
		const first = openSocket();
		// Priming (seq below DELTA_SEQ_START) then ringed deltas.
		dispatch(attached("session-a"));
		dispatchSeq(echo("primed"), 3);
		dispatchSeq(echo("d1"), 1024);
		dispatchSeq(echo("d2"), 1025);
		expect(echoCount("d2")).toBe(1);

		first.serverClose(1006); // the network drops the socket
		expect(state.connected).toBe(false);
		vi.advanceTimersByTime(state.reconnectDelay);
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(new URL(current().url).searchParams.get("after")).toBe("1025");

		current().onopen?.();
		// The server replays its ring after 1025: the delta the drop swallowed
		// (1026), delivered again by the live path racing the replay.
		dispatchSeq(echo("d3"), 1026);
		dispatchSeq(echo("d3"), 1026);
		dispatchSeq(echo("d4"), 1027);
		expect(echoCount("d3")).toBe(1);
		expect(echoCount("d4")).toBe(1);
		// Nothing before the resume point was applied twice.
		expect(echoCount("d1")).toBe(1);
		expect(echoCount("d2")).toBe(1);
	});

	test("a reconnect re-attaches the daemon the tab was viewing", () => {
		vi.useFakeTimers();
		const first = openSocket();
		dispatch(attached("session-a"));
		first.serverClose(1006);
		vi.advanceTimersByTime(state.reconnectDelay);
		posted.length = 0;
		current().onopen?.();
		expect(posted.filter((c) => c.type === "attach")).toMatchObject([
			{ type: "attach", sessionId: "session-a" },
		]);
	});

	test("seqs of a new connection's priming are not mistaken for the previous connection's frames", () => {
		vi.useFakeTimers();
		const first = openSocket();
		dispatchSeq(echo("prime-1"), 1);
		first.serverClose(1006);
		vi.advanceTimersByTime(state.reconnectDelay);
		current().onopen?.();
		dispatchSeq(echo("prime-2"), 1); // seq 1 again: a different frame on a new connection
		expect(echoCount("prime-1")).toBe(1);
		expect(echoCount("prime-2")).toBe(1);
	});
});

describe("reconnect ladder", () => {
	test("the delay grows over failed dials and resets once a socket delivers its first message", () => {
		vi.useFakeTimers();
		let ws = openSocket();
		ws.serverClose(1006);
		const first = state.reconnectDelay;
		expect(first).toBeGreaterThanOrEqual(500);
		expect(first).toBeLessThanOrEqual(1000);
		vi.advanceTimersByTime(first);
		ws = current();
		ws.serverClose(1006); // dial failed before any message
		const second = state.reconnectDelay;
		expect(second).toBeGreaterThanOrEqual(1000);
		expect(second).toBeLessThanOrEqual(2000);
		vi.advanceTimersByTime(second);
		ws = current();
		ws.onopen?.();
		ws.ping(); // first message: the attempt count resets
		ws.serverClose(1006);
		expect(state.reconnectDelay).toBeLessThanOrEqual(1000);
	});

	test("a malformed server message closes 4400 and reconnects with backoff", () => {
		vi.useFakeTimers();
		const ws = openSocket();
		ws.message("not json");
		expect(ws.closed?.code).toBe(4400);
		expect(state.connected).toBe(false);
		expect(state.reconnectDelay).toBeGreaterThan(0);
		vi.advanceTimersByTime(state.reconnectDelay);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});

	test("a binary message is malformed too", () => {
		const ws = openSocket();
		ws.message(new ArrayBuffer(4));
		expect(ws.closed?.code).toBe(4400);
	});

	test("4503 after the socket delivered resumes immediately; with no message yet it backs off", () => {
		vi.useFakeTimers();
		const delivering = openSocket();
		delivering.ping();
		closeTyped(delivering, "slow_consumer", "buffer over cap");
		expect(FakeWebSocket.instances).toHaveLength(2); // redialed at once, no timer
		expect(state.reconnectDelay).toBe(0);

		const silent = current();
		silent.onopen?.();
		closeTyped(silent, "slow_consumer", "buffer over cap");
		expect(FakeWebSocket.instances).toHaveLength(2);
		expect(state.reconnectDelay).toBeGreaterThan(0);
	});
});

describe("silence deadline", () => {
	test("30s without any message closes the socket and redials at once; any message re-arms it", () => {
		vi.useFakeTimers();
		const ws = openSocket();
		vi.advanceTimersByTime(CLIENT_SILENCE_DEADLINE_MS - 1);
		ws.ping(); // keepalive: the peer is alive
		vi.advanceTimersByTime(CLIENT_SILENCE_DEADLINE_MS - 1);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(ws.closed).toBeNull();

		vi.advanceTimersByTime(1);
		expect(ws.closed).not.toBeNull();
		expect(FakeWebSocket.instances).toHaveLength(2); // no backoff delay
		expect(state.connected).toBe(false);
		expect(new URL(current().url).pathname).toBe("/ws");
		current().onopen?.();
		expect(state.connected).toBe(true);
	});

	test("an ack and a frame count as liveness; lastFrameAt follows them", () => {
		vi.useFakeTimers();
		const ws = openSocket();
		expect(state.lastFrameAt).toBe(0);
		vi.advanceTimersByTime(CLIENT_SILENCE_DEADLINE_MS - 1);
		dispatch(echo("alive"));
		expect(state.lastFrameAt).toBeGreaterThan(0);
		vi.advanceTimersByTime(CLIENT_SILENCE_DEADLINE_MS - 1);
		expect(ws.closed).toBeNull();
	});
});

describe("commands in band", () => {
	test("a command goes out as {cmd}, and its ack resolves it", async () => {
		const ws = openSocket();
		FakeWebSocket.autoAck = false;
		const done = sendCommand({ type: "stop", id: "cmd-1", daemonId: "d1" });
		expect(JSON.parse(ws.sent.at(-1)!)).toEqual({
			cmd: { type: "stop", id: "cmd-1", daemonId: "d1" },
		});
		let settled = false;
		void done.then(() => (settled = true));
		await flushMicrotasks();
		expect(settled).toBe(false);
		ws.ack("cmd-1");
		await done;
	});

	test("a nack rejects with the command and status; 413 surfaces the server's size error", async () => {
		const ws = openSocket();
		FakeWebSocket.autoAck = false;
		const refused = sendCommand({ type: "stop", id: "cmd-2", daemonId: "d1" });
		ws.nack("cmd-2", 503, "busy");
		await expect(refused).rejects.toThrow('command "stop" rejected (HTTP 503)');

		const big = sendCommand({ type: "stop", id: "cmd-3", daemonId: "d1" });
		ws.nack("cmd-3", 413, "this request is 40.0 MiB, over the 32.0 MiB per-message limit");
		await expect(big).rejects.toThrow("over the 32.0 MiB per-message limit");
	});

	test("a nack 401 means the session is gone: the sign-in modal opens", async () => {
		await signInStub();
		const unsubscribe = initAuth();
		try {
			const ws = openSocket();
			FakeWebSocket.autoAck = false;
			const refused = sendCommand({ type: "stop", id: "cmd-4", daemonId: "d1" });
			ws.nack("cmd-4", 401, "unauthorized");
			await expect(refused).rejects.toThrow("HTTP 401");
			expect(state.authStatus).toBe("signedOut");
			expect(state.modal).toBe("sign-in");
		} finally {
			unsubscribe();
		}
	});

	test("a command issued while disconnected waits for the next open instead of failing", async () => {
		vi.useFakeTimers();
		const first = openSocket();
		first.serverClose(1006);
		const queued = sendCommand({ type: "stop", id: "cmd-5", daemonId: "d1" });
		expect(posted).toHaveLength(0);
		vi.advanceTimersByTime(state.reconnectDelay);
		current().onopen?.();
		expect(posted).toMatchObject([{ type: "stop", id: "cmd-5" }]);
		await queued; // acked by the new socket
	});

	test("an unacked command is re-sent with the same id after the reconnect, and settles on the new ack", async () => {
		vi.useFakeTimers();
		const first = openSocket();
		FakeWebSocket.autoAck = false;
		const done = sendCommand({ type: "stop", id: "cmd-6", daemonId: "d1" });
		expect(posted.map((c) => c.id)).toEqual(["cmd-6"]);

		first.serverClose(1006); // the ack never came
		vi.advanceTimersByTime(state.reconnectDelay);
		const second = current();
		second.onopen?.();
		expect(posted.map((c) => c.id)).toEqual(["cmd-6", "cmd-6"]);
		expect(second.sent).toHaveLength(1);
		second.ack("cmd-6");
		await done;

		// Acked: another reconnect does not send it a third time.
		second.serverClose(1006);
		vi.advanceTimersByTime(state.reconnectDelay);
		current().onopen?.();
		expect(posted.map((c) => c.id)).toEqual(["cmd-6", "cmd-6"]);
	});

	test("an unacked command past the dedup window fails with Disconnected and is never re-sent", async () => {
		vi.useFakeTimers();
		let now = 5_000_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const first = openSocket();
		FakeWebSocket.autoAck = false;
		const done = sendCommand({ type: "stop", id: "cmd-7", daemonId: "d1" });
		first.serverClose(1006);
		now += COMMAND_DEDUP_WINDOW_MS + 1; // a re-send now could execute twice
		vi.advanceTimersByTime(state.reconnectDelay);
		current().onopen?.();
		await expect(done).rejects.toThrow("Disconnected");
		expect(posted.map((c) => c.id)).toEqual(["cmd-7"]);
	});

	test("a call whose answer never came survives the drop and is re-sent under its own id; the replayed answer settles it", async () => {
		vi.useFakeTimers();
		const first = openSocket();
		const outcome: { value?: unknown; error?: Error } = {};
		const pending = call("getSubagents", [], 0).then(
			(value) => (outcome.value = value),
			(error: Error) => (outcome.error = error),
		);
		const id = [...pendingCalls.keys()][0]!;
		expect(posted.filter((c) => c.id === id)).toHaveLength(1);

		first.serverClose(1006); // acked, answer lost with the socket
		await flushMicrotasks();
		expect(pendingCalls.has(id)).toBe(true);
		expect(outcome.error).toBeUndefined();

		vi.advanceTimersByTime(state.reconnectDelay);
		current().onopen?.();
		expect(posted.filter((c) => c.id === id)).toHaveLength(2); // same id: the daemon dedups it
		dispatch(callResult(id, ["answer"]));
		await pending;
		expect(outcome.value).toEqual(["answer"]);
		expect(pendingCalls.has(id)).toBe(false);
	});

	test("a call past the dedup window fails with Disconnected at the next open instead of being re-sent", async () => {
		vi.useFakeTimers();
		let now = 7_000_000;
		spyOn(Date, "now").mockImplementation(() => now);
		const first = openSocket();
		const settled = call("getSubagents", [], 0).then(
			() => "resolved",
			(error: Error) => error.message,
		);
		const id = [...pendingCalls.keys()][0]!;
		first.serverClose(1006);
		now += COMMAND_DEDUP_WINDOW_MS + 1;
		vi.advanceTimersByTime(state.reconnectDelay);
		current().onopen?.();
		expect(await settled).toBe("Disconnected");
		expect(posted.filter((c) => c.id === id)).toHaveLength(1);
	});

	test("a session switch still rejects pending calls without waiting for a reconnect", async () => {
		openSocket();
		dispatch(attached("session-a"));
		const stale = call("getSubagents", [], 0).then(
			() => "resolved",
			(error: Error) => error.message,
		);
		dispatch(attached("session-b"));
		expect(await stale).toBe("session switched");
	});
});

describe("typed closes", () => {
	test("4401 is the signed-out flow: sign-in modal, no reconnect until the sign-in succeeds, then a fresh dial", async () => {
		vi.useFakeTimers();
		await signInStub();
		const unsubscribe = initAuth();
		try {
			const ws = openSocket();
			const pending = call("getSubagents", [], 0).then(
				() => "resolved",
				(error: Error) => error.message,
			);
			closeTyped(ws, "unauthorized", "session expired");
			expect(state.authStatus).toBe("signedOut");
			expect(state.modal).toBe("sign-in");
			expect(state.connected).toBe(false);

			vi.advanceTimersByTime(10 * 60_000);
			expect(FakeWebSocket.instances).toHaveLength(1); // held until sign-in
			expect(state.error).toBeNull(); // not a terminal error: the modal is the surface

			await signInStub();
			expect(state.authStatus).toBe("signedIn");
			expect(FakeWebSocket.instances).toHaveLength(2);
			current().onopen?.();
			expect(state.connected).toBe(true);
			// The call that waited out the sign-in goes out again under its own id.
			const id = [...pendingCalls.keys()][0]!;
			expect(posted.filter((c) => c.id === id)).toHaveLength(2);
			dispatch(callResult(id, "ok"));
			expect(await pending).toBe("resolved");
		} finally {
			unsubscribe();
		}
	});

	test("4426 is the proto-mismatch error path: error shown, no reconnect", async () => {
		vi.useFakeTimers();
		const ws = openSocket();
		const pending = call("getSubagents", [], 0).then(
			() => "resolved",
			(error: Error) => error.message,
		);
		closeTyped(ws, "proto_mismatch", "this server speaks OMP_PROTO 6");
		expect(state.error).toContain("proto mismatch");
		expect(state.error).toContain(`expected ${OMP_PROTO}`);
		expect(state.error).toContain("OMP_PROTO 6");
		expect(state.connected).toBe(false);
		vi.advanceTimersByTime(10 * 60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
		expect(await pending).toBe("Disconnected"); // nothing will resend it
	});

	test("4403 is a terminal error, no reconnect", () => {
		vi.useFakeTimers();
		const ws = openSocket();
		closeTyped(ws, "forbidden", "origin refused");
		expect(state.error).toContain("origin refused");
		expect(state.connected).toBe(false);
		vi.advanceTimersByTime(10 * 60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});

	test("an unlisted or ordinary close reconnects with backoff", () => {
		vi.useFakeTimers();
		openSocket().serverClose(1001, "going away");
		expect(state.reconnectDelay).toBeGreaterThan(0);
		vi.advanceTimersByTime(state.reconnectDelay);
		expect(FakeWebSocket.instances).toHaveLength(2);
	});
});

describe("hello_ok proto gate over the socket", () => {
	test("a hello_ok naming another proto is terminal on the socket too", () => {
		vi.useFakeTimers();
		const ws = openSocket();
		dispatch({ type: "hello_ok", proto: OMP_PROTO + 1, name: "x", cwd: "/", pid: 1, version: "0" });
		expect(state.error).toContain("proto mismatch");
		expect(ws.closed).not.toBeNull();
		vi.advanceTimersByTime(10 * 60_000);
		expect(FakeWebSocket.instances).toHaveLength(1);
	});
});
