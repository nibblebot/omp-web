import { afterEach, describe, expect, jest, test } from "bun:test";
import { parseServerMessage } from "#lib/wire/browser-socket";
import {
	CLIENT_BACKPRESSURE_BYTES,
	CLIENT_KEEPALIVE_MS,
	type ServerFrame,
} from "#lib/wire/protocol";
import {
	answeringTo,
	broadcast,
	broadcastAnswer,
	detachConsumer,
	ringAfter,
	sendPaced,
	sendTo,
	setOnFrameTap,
	snapshotDeltaSeq,
	startKeepalive,
	stopKeepalive,
	streams,
	wakeDrainWaiter,
	type ClientConsumer,
} from "../client-delivery";

/** A socket stand-in that records what is sent and closed; `buffered` and `sendResult` are the knobs. */
interface FakeSocket {
	sent: string[];
	closes: Array<{ code: number; reason: string }>;
	buffered: number;
	/** What `send` returns: the byte count (default), -1 queued, 0 dropped. */
	sendResult: "bytes" | -1 | 0;
	readyState: number;
}

let nextId = 1;

function fakeConsumer(overrides: Partial<FakeSocket> = {}): {
	consumer: ClientConsumer;
	socket: FakeSocket;
} {
	const socket: FakeSocket = {
		sent: [],
		closes: [],
		buffered: 0,
		sendResult: "bytes",
		readyState: 1,
		...overrides,
	};
	const ws = {
		get readyState() {
			return socket.readyState;
		},
		getBufferedAmount: () => socket.buffered,
		send: (message: string) => {
			socket.sent.push(message);
			return socket.sendResult === "bytes" ? message.length : socket.sendResult;
		},
		close: (code: number, reason: string) => {
			socket.closes.push({ code, reason });
			socket.readyState = 2;
		},
	};
	const consumer = {
		id: 1000 + nextId++,
		ws: ws as unknown as ClientConsumer["ws"],
		attached: "s1",
		lastSendAt: 0,
	} satisfies ClientConsumer;
	return { consumer, socket };
}

const live = new Set<ClientConsumer>();

/** A consumer registered the way the socket's `open` registers one. */
function attach(overrides: Partial<FakeSocket> = {}): ReturnType<typeof fakeConsumer> {
	const made = fakeConsumer(overrides);
	streams.add(made.consumer);
	live.add(made.consumer);
	return made;
}

afterEach(() => {
	for (const consumer of live) detachConsumer(consumer, "test cleanup");
	live.clear();
	stopKeepalive();
	jest.useRealTimers();
});

const errorFrame = (error: string): ServerFrame => ({ type: "error", error });
const answerFrame = (id: string): ServerFrame => ({
	type: "call_result",
	id,
	ok: true,
	data: null,
});

function parsed(message: string): { seq: number | null; frame: ServerFrame } {
	const result = parseServerMessage(message);
	if (result?.kind !== "frame") throw new Error(`not a frame message: ${message}`);
	return result;
}

describe("sequencing and the replay ring", () => {
	test("deltas ring under daemon-global seqs; answers are sequenced but never ringed", () => {
		const { consumer, socket } = attach();
		const floor = snapshotDeltaSeq() - 1;
		broadcast(errorFrame("first"));
		broadcastAnswer(answerFrame("a1"));
		broadcast(errorFrame("second"));

		// The socket got all three in order, one text message per frame, each seq-stamped.
		const got = socket.sent.map(parsed);
		expect(got.map((m) => m.frame.type)).toEqual(["error", "call_result", "error"]);
		expect(got.map((m) => m.seq)).toEqual([floor + 1, floor + 2, floor + 3]);

		// The ring holds the deltas only, with the exact bytes the socket received.
		const ringed = ringAfter(floor);
		expect(ringed.map((entry) => entry.seq)).toEqual([floor + 1, floor + 3]);
		expect(ringed.map((entry) => entry.value)).toEqual([socket.sent[0]!, socket.sent[2]!]);
		expect(consumer.lastSendAt).toBeGreaterThan(0);
	});

	test("ringAfter resumes strictly after the given seq: no repeat, no gap", () => {
		attach();
		const floor = snapshotDeltaSeq() - 1;
		for (const name of ["a", "b", "c", "d"]) broadcast(errorFrame(name));
		const after = ringAfter(floor + 2);
		expect(after.map((entry) => entry.seq)).toEqual([floor + 3, floor + 4]);
		expect(
			after.map((entry) => {
				const { frame } = parsed(entry.value);
				return frame.type === "error" ? frame.error : null;
			}),
		).toEqual(["c", "d"]);
		expect(ringAfter(floor + 4)).toEqual([]);
	});
});

describe("answers go only to the originating socket", () => {
	test("an answer produced inside answeringTo reaches that socket alone, even across awaits", async () => {
		const a = attach();
		const b = attach();
		await answeringTo(a.consumer, async () => {
			await Promise.resolve();
			broadcastAnswer(answerFrame("only-a"));
		});
		expect(a.socket.sent.map((m) => parsed(m).frame.type)).toEqual(["call_result"]);
		expect(b.socket.sent).toEqual([]);
	});

	test("with no originating socket (the callback pair's dispatch) an answer reaches every socket", () => {
		const a = attach();
		const b = attach();
		broadcastAnswer(answerFrame("everyone"));
		expect(a.socket.sent).toHaveLength(1);
		expect(b.socket.sent).toHaveLength(1);
	});

	test("an originating socket that closed receives nothing and no sibling picks the answer up", () => {
		const a = attach();
		const b = attach();
		detachConsumer(a.consumer, "closed");
		a.socket.readyState = 3;
		answeringTo(a.consumer, () => broadcastAnswer(answerFrame("late")));
		expect(a.socket.sent).toEqual([]);
		expect(b.socket.sent).toEqual([]);
	});

	test("the frame tap still sees a routed answer", () => {
		const a = attach();
		const tapped: ServerFrame[] = [];
		setOnFrameTap((frame) => tapped.push(frame as ServerFrame));
		try {
			answeringTo(a.consumer, () => broadcastAnswer(answerFrame("tap")));
		} finally {
			setOnFrameTap(null);
		}
		expect(tapped.map((f) => f.type)).toEqual(["call_result"]);
	});
});

describe("per-socket backpressure", () => {
	test("a socket buffering past the cap is closed 4503 and detached, not sent to", () => {
		const { consumer, socket } = attach({ buffered: CLIENT_BACKPRESSURE_BYTES + 1 });
		sendTo(consumer, "{}");
		expect(socket.sent).toEqual([]);
		expect(socket.closes).toHaveLength(1);
		expect(socket.closes[0]!.code).toBe(4503);
		expect(socket.closes[0]!.reason).toStartWith("slow_consumer:");
		expect(streams.has(consumer)).toBe(false);
	});

	test("a send the socket dropped (returns 0) closes 4503 the same way", () => {
		const { consumer, socket } = attach({ sendResult: 0 });
		sendTo(consumer, "{}");
		expect(socket.closes.map((c) => c.code)).toEqual([4503]);
		expect(streams.has(consumer)).toBe(false);
	});

	test("a queued send (-1) is neither a drop nor a close, and a buffer at the cap still sends", () => {
		const { consumer, socket } = attach({ sendResult: -1, buffered: CLIENT_BACKPRESSURE_BYTES });
		sendTo(consumer, "{}");
		expect(socket.sent).toEqual(["{}"]);
		expect(socket.closes).toEqual([]);
		expect(streams.has(consumer)).toBe(true);
	});

	test("a socket that is not open is skipped without a close", () => {
		const { consumer, socket } = attach({ readyState: 2 });
		sendTo(consumer, "{}");
		expect(socket.sent).toEqual([]);
		expect(socket.closes).toEqual([]);
	});

	test("one slow socket never stalls delivery to the others", () => {
		const slow = attach({ buffered: CLIENT_BACKPRESSURE_BYTES + 1 });
		const fast = attach();
		broadcast(errorFrame("both"));
		expect(slow.socket.closes.map((c) => c.code)).toEqual([4503]);
		expect(fast.socket.sent).toHaveLength(1);
		expect(streams.has(fast.consumer)).toBe(true);
	});
});

describe("paced priming", () => {
	test("waits for the socket to drain below the margin, then sends", async () => {
		const { consumer, socket } = attach({ buffered: CLIENT_BACKPRESSURE_BYTES - 100_000 });
		const message = `{"frame":"${"x".repeat(200_000)}"}`;
		const done = sendPaced(consumer, message).then(() => "sent" as const);
		// Parked: the socket is nearly full, so nothing is written yet.
		expect(await Promise.race([done, Promise.resolve("waiting" as const)])).toBe("waiting");
		expect(socket.sent).toEqual([]);
		socket.buffered = 0;
		wakeDrainWaiter(consumer);
		expect(await done).toBe("sent");
		expect(socket.sent).toEqual([message]);
		expect(socket.closes).toEqual([]);
	});

	test("an empty buffer admits a message larger than the room", async () => {
		const { consumer, socket } = attach({ sendResult: -1 });
		const message = `{"frame":"${"y".repeat(CLIENT_BACKPRESSURE_BYTES)}"}`;
		await sendPaced(consumer, message);
		expect(socket.sent).toEqual([message]);
		expect(socket.closes).toEqual([]);
	});

	test("a socket that closes mid-wait ends the wait without sending", async () => {
		const { consumer, socket } = attach({ buffered: CLIENT_BACKPRESSURE_BYTES - 100_000 });
		const done = sendPaced(consumer, `{"frame":"${"z".repeat(200_000)}"}`);
		detachConsumer(consumer, "socket closed");
		await done;
		expect(socket.sent).toEqual([]);
	});
});

describe("keepalive", () => {
	test("pings an idle socket every CLIENT_KEEPALIVE_MS and leaves a recently active one alone", () => {
		jest.useFakeTimers();
		const idle = attach();
		const active = attach();
		active.consumer.lastSendAt = Number.MAX_SAFE_INTEGER;
		startKeepalive();
		jest.advanceTimersByTime(CLIENT_KEEPALIVE_MS);
		expect(idle.socket.sent).toHaveLength(1);
		expect(parseServerMessage(idle.socket.sent[0]!)?.kind).toBe("ping");
		expect(active.socket.sent).toEqual([]);
		jest.advanceTimersByTime(CLIENT_KEEPALIVE_MS);
		expect(idle.socket.sent).toHaveLength(2);
	});

	test("the keepalive stops with the last socket", () => {
		jest.useFakeTimers();
		const { consumer, socket } = attach();
		startKeepalive();
		detachConsumer(consumer, "closed");
		jest.advanceTimersByTime(CLIENT_KEEPALIVE_MS * 3);
		expect(socket.sent).toEqual([]);
	});
});

describe("stall rule", () => {
	test("a socket holding bytes with no drain for the stall limit is closed 4503 on a sweep", () => {
		jest.useFakeTimers();
		const stuck = attach({ buffered: 1000 });
		const healthy = attach();
		startKeepalive({ sweepMs: 100, stallMs: 450 });
		jest.advanceTimersByTime(400);
		expect(stuck.socket.closes).toEqual([]);
		jest.advanceTimersByTime(300);
		expect(stuck.socket.closes.map((c) => c.code)).toEqual([4503]);
		expect(stuck.socket.closes[0]!.reason).toContain("stalled");
		expect(streams.has(stuck.consumer)).toBe(false);
		expect(healthy.socket.closes).toEqual([]);
		expect(streams.has(healthy.consumer)).toBe(true);
	});

	test("a buffer that shrinks, or a drain, restarts the clock", () => {
		jest.useFakeTimers();
		const slow = attach({ buffered: 1000 });
		startKeepalive({ sweepMs: 100, stallMs: 450 });
		jest.advanceTimersByTime(300);
		slow.socket.buffered = 600; // progress: the peer is reading
		jest.advanceTimersByTime(300);
		slow.socket.buffered = 600;
		wakeDrainWaiter(slow.consumer); // the socket's drain event
		jest.advanceTimersByTime(300);
		expect(slow.socket.closes).toEqual([]);
		jest.advanceTimersByTime(600); // now nothing moves for longer than the limit
		expect(slow.socket.closes.map((c) => c.code)).toEqual([4503]);
	});

	test("an empty buffer never stalls", () => {
		jest.useFakeTimers();
		const idle = attach();
		startKeepalive({ sweepMs: 100, stallMs: 150 });
		jest.advanceTimersByTime(2000);
		expect(idle.socket.closes).toEqual([]);
	});
});
