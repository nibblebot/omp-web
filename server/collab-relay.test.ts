/**
 * Tests for the collab relay (server/collab-relay.ts).
 *
 * Spins real Bun.serve instances wired to createRelay() instances and drives
 * them with Bun's client WebSocket (binaryType "arraybuffer"). Every test uses
 * a unique roomId so rooms never collide; each room's sockets are closed
 * before the test ends, and all servers are stopped in afterAll.
 *
 * Real-time sleeps appear only where the code under test owns the clock:
 * the relay arms its own internal setTimeout for the orphan TTL (fake timers
 * can't reach inside the module, and the design contract mandates short real
 * TTL waits), plus two short absence-checks ("X did NOT arrive") that need a
 * real observation window. Everything else awaits actual events.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateRoomId, packEnvelope } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { Server } from "bun";
import { createRelay } from "./collab-relay";
import type { RelayHandle, RelayOptions, RelaySocketData } from "./collab-relay";

const PAYLOAD_A = new Uint8Array([1, 2, 3, 4, 5]);
const PAYLOAD_B = new Uint8Array([9, 8, 7, 6]);

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

const servers: Server<RelaySocketData>[] = [];
const clients: WebSocket[] = [];

function startRelayServer(opts?: RelayOptions): { relay: RelayHandle; server: Server<RelaySocketData>; baseUrl: string } {
	const relay = createRelay(opts);
	const server = Bun.serve<RelaySocketData>({
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			const result = relay.handleUpgrade(url, srv, req);
			if (result === null) return new Response("not found", { status: 404 });
			if (result.handled) return;
			return new Response(result.reason, { status: result.status });
		},
		websocket: {
			open(ws) {
				relay.handleOpen(ws);
			},
			message(ws, raw) {
				relay.handleMessage(ws, raw);
			},
			close(ws) {
				relay.handleClose(ws);
			},
		},
	});
	servers.push(server);
	return { relay, server, baseUrl: `ws://127.0.0.1:${server.port}` };
}

function openRelaySocket(baseUrl: string, roomId: string, role: "host" | "guest"): WebSocket {
	const ws = new WebSocket(`${baseUrl}/r/${roomId}?role=${role}`);
	ws.binaryType = "arraybuffer";
	clients.push(ws);
	return ws;
}

function awaitOpen(ws: WebSocket): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (ws.readyState === WebSocket.OPEN) {
		resolve();
		return promise;
	}
	ws.onopen = () => resolve();
	ws.onerror = () => reject(new Error("websocket failed before open"));
	return promise;
}

/** Resolves with the close event's code/reason; rejects on timeout. Install before the close can fire. */
function awaitClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ code: number; reason: string }>();
	const timer = setTimeout(() => reject(new Error("timed out waiting for close event")), timeoutMs);
	ws.onclose = (ev) => {
		clearTimeout(timer);
		resolve({ code: ev.code, reason: ev.reason });
	};
	return promise;
}

/** Splits incoming frames into TEXT controls (parsed JSON) and binary envelopes (ArrayBuffer). */
function collect(ws: WebSocket): { controls: Array<Record<string, unknown>>; binaries: ArrayBuffer[] } {
	const bag = { controls: [] as Array<Record<string, unknown>>, binaries: [] as ArrayBuffer[] };
	ws.onmessage = (ev: MessageEvent) => {
		if (typeof ev.data === "string") bag.controls.push(JSON.parse(ev.data) as Record<string, unknown>);
		else bag.binaries.push(ev.data as ArrayBuffer);
	};
	return bag;
}

async function waitFor<T>(probe: () => T | undefined, label: string, timeoutMs = 2000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
		await sleep(5);
	}
}

/** First 4 bytes of an envelope, big-endian: the peerId. */
function envelopePeer(buf: ArrayBuffer): number {
	return new DataView(buf).getUint32(0, false);
}

/**
 * Build a [4B uint32 BE peerId][payload] envelope as an ArrayBuffer. Bun's
 * client WebSocket.send() is typed against the DOM BufferSource (strict
 * ArrayBuffer-backed views), while packEnvelope() returns a generic
 * Uint8Array<ArrayBufferLike>, so copy into a fresh ArrayBuffer for sends.
 */
function makeEnvelope(peerId: number, payload: Uint8Array): ArrayBuffer {
	const env = packEnvelope(peerId, payload);
	const copy = new Uint8Array(env.byteLength);
	copy.set(env);
	return copy.buffer;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

let shared: { relay: RelayHandle; server: Server<RelaySocketData>; baseUrl: string } | null = null;

beforeAll(() => {
	shared = startRelayServer();
});

afterAll(async () => {
	// NOTE: server.stop() is deliberately NOT called. When the relay closes a
	// socket with a close code (4004/4009/4029/4001), Bun's stop() hangs
	// forever (it waits on a connection that never leaves CLOSING state), so
	// the afterAll hook would time out. Closing every client and letting bun
	// test exit on its own is reliable (verified against bun 1.3.14).
	for (const ws of clients) {
		try {
			ws.close();
		} catch {
			// already closed
		}
	}
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collab relay", () => {
	test("guest joining a missing room is closed with 4004", async () => {
		const base = shared!.baseUrl;
		const guest = openRelaySocket(base, generateRoomId(), "guest");
		const ev = await awaitClose(guest);
		expect(ev.code).toBe(4004);
		expect(ev.reason).toBe("no such room");
	});

	test("a second host for a live room is closed with 4009", async () => {
		const base = shared!.baseUrl;
		const room = generateRoomId();
		const host1 = openRelaySocket(base, room, "host");
		await awaitOpen(host1);

		const host2 = openRelaySocket(base, room, "host");
		const ev = await awaitClose(host2);
		expect(ev.code).toBe(4009);

		// The original host is untouched: a guest can still join and is announced.
		const bag = collect(host1);
		const guest = openRelaySocket(base, room, "guest");
		await awaitOpen(guest);
		const joined = await waitFor(() => bag.controls.find((m) => m.t === "peer-joined"), "peer-joined control");
		expect(joined).toEqual({ t: "peer-joined", peer: 1 });
	});

	test("a third socket is refused with 4029 when maxGuests is 1", async () => {
		const { relay, baseUrl } = startRelayServer({ maxGuests: 1 });
		const room = generateRoomId();
		const host = openRelaySocket(baseUrl, room, "host");
		await awaitOpen(host);
		const guest1 = openRelaySocket(baseUrl, room, "guest");
		await awaitOpen(guest1);

		const guest2 = openRelaySocket(baseUrl, room, "guest");
		const ev = await awaitClose(guest2);
		expect(ev.code).toBe(4029);
		expect(ev.reason).toBe("room is full");

		expect(relay.roomCount()).toBe(1);
	});

	test("host upgrades are refused with 401 when the authorizeHost predicate rejects; guests stay open", async () => {
		// The daemon wires authorizeHost to the R14 gate (loopback exempt,
		// off-loopback needs the bearer token). Here the predicate models an
		// off-loopback peer without a token: every host upgrade is refused.
		const { baseUrl } = startRelayServer({ authorizeHost: () => false });
		const room = generateRoomId();
		const httpBase = `http://127.0.0.1:${new URL(baseUrl).port}`;

		// Refused BEFORE the upgrade with a plain 401 (no close code, no
		// hello window — same convention as /events and /command).
		const res = await fetch(`${httpBase}/r/${room}?role=host`);
		expect(res.status).toBe(401);

		// Guests are never gated: they still upgrade and get the ordinary
		// no-room close instead of a 401.
		const guest = openRelaySocket(baseUrl, room, "guest");
		await awaitOpen(guest);
		const ev = await awaitClose(guest);
		expect(ev.code).toBe(4004);
		expect(ev.reason).toBe("no such room");
	});

	test("host upgrades proceed when the authorizeHost predicate accepts", async () => {
		// The predicate models a loopback peer (or an off-loopback peer with
		// a valid token): the upgrade goes through and the room is created.
		const { relay, baseUrl } = startRelayServer({ authorizeHost: () => true });
		const room = generateRoomId();
		const host = openRelaySocket(baseUrl, room, "host");
		await awaitOpen(host);
		expect(relay.roomCount()).toBe(1);
		relay.closeRoom(room);
	});

	test("new host rooms past maxRooms are refused with 503; re-adoption still works at the cap", async () => {
		const { relay, baseUrl } = startRelayServer({ maxRooms: 2 });
		const httpBase = `http://127.0.0.1:${new URL(baseUrl).port}`;
		const roomA = generateRoomId();
		const roomB = generateRoomId();
		const hostA = openRelaySocket(baseUrl, roomA, "host");
		await awaitOpen(hostA);
		const hostB = openRelaySocket(baseUrl, roomB, "host");
		await awaitOpen(hostB);
		expect(relay.roomCount()).toBe(2);

		// A third NEW room is refused before the upgrade with 503.
		const res = await fetch(`${httpBase}/r/${generateRoomId()}?role=host`);
		expect(res.status).toBe(503);
		expect(relay.roomCount()).toBe(2);

		// The cap must not cut the host-resume path: an orphaned room is
		// re-adopted even though the cap is already reached.
		hostA.close();
		await sleep(100);
		const hostA2 = openRelaySocket(baseUrl, roomA, "host");
		await awaitOpen(hostA2);
		expect(relay.roomCount()).toBe(2);

		relay.closeRoom(roomA);
		relay.closeRoom(roomB);
	});

	test("guest join sends a peer-joined control to the host", async () => {
		const base = shared!.baseUrl;
		const room = generateRoomId();
		const host = openRelaySocket(base, room, "host");
		await awaitOpen(host);
		const bag = collect(host);

		const guest = openRelaySocket(base, room, "guest");
		await awaitOpen(guest);

		const joined = await waitFor(() => bag.controls.find((m) => m.t === "peer-joined"), "peer-joined control");
		expect(joined).toEqual({ t: "peer-joined", peer: 1 });
	});

	test("guest envelopes reach the host with the sender's peerId rewritten", async () => {
		const base = shared!.baseUrl;
		const room = generateRoomId();
		const host = openRelaySocket(base, room, "host");
		await awaitOpen(host);
		const bag = collect(host);

		const guest1 = openRelaySocket(base, room, "guest");
		await awaitOpen(guest1);
		const guest2 = openRelaySocket(base, room, "guest");
		await awaitOpen(guest2);

		guest1.send(makeEnvelope(0, PAYLOAD_A));
		const env1 = await waitFor(() => bag.binaries.shift(), "envelope from guest 1");
		expect(envelopePeer(env1)).toBe(1);
		expect(bytesEqual(new Uint8Array(env1).slice(4), PAYLOAD_A)).toBe(true);

		guest2.send(makeEnvelope(0, PAYLOAD_B));
		const env2 = await waitFor(() => bag.binaries.shift(), "envelope from guest 2");
		expect(envelopePeer(env2)).toBe(2);
		expect(bytesEqual(new Uint8Array(env2).slice(4), PAYLOAD_B)).toBe(true);

		// Only the two peer-joined controls arrived as TEXT — no envelope leaked.
		expect(bag.controls).toEqual([
			{ t: "peer-joined", peer: 1 },
			{ t: "peer-joined", peer: 2 },
		]);
	});

	test("host broadcast reaches every guest; targeted envelopes reach only the target", async () => {
		const base = shared!.baseUrl;
		const room = generateRoomId();
		const host = openRelaySocket(base, room, "host");
		await awaitOpen(host);
		const guest1 = openRelaySocket(base, room, "guest");
		const guest2 = openRelaySocket(base, room, "guest");
		const g1 = collect(guest1);
		const g2 = collect(guest2);
		await awaitOpen(guest1);
		await awaitOpen(guest2);

		// Broadcast (peer 0): both guests receive the identical envelope.
		host.send(makeEnvelope(0, PAYLOAD_A));
		await waitFor(() => (g1.binaries.length >= 1 && g2.binaries.length >= 1 ? true : undefined), "broadcast to both");
		expect(envelopePeer(g1.binaries[0])).toBe(0);
		expect(bytesEqual(new Uint8Array(g1.binaries[0]).slice(4), PAYLOAD_A)).toBe(true);
		expect(bytesEqual(new Uint8Array(g2.binaries[0]), new Uint8Array(g1.binaries[0]))).toBe(true);

		// Targeted (peer 1): only guest 1 receives. Short real wait is an
		// absence-check that guest 2 got nothing.
		host.send(makeEnvelope(1, PAYLOAD_B));
		await waitFor(() => (g1.binaries.length >= 2 ? true : undefined), "targeted envelope");
		expect(envelopePeer(g1.binaries[1])).toBe(1);
		expect(bytesEqual(new Uint8Array(g1.binaries[1]).slice(4), PAYLOAD_B)).toBe(true);
		await sleep(50);
		expect(g2.binaries.length).toBe(1);
	});

	test("guest close sends a peer-left control to the host", async () => {
		const base = shared!.baseUrl;
		const room = generateRoomId();
		const host = openRelaySocket(base, room, "host");
		await awaitOpen(host);
		const bag = collect(host);

		const guest = openRelaySocket(base, room, "guest");
		await awaitOpen(guest);
		await waitFor(() => bag.controls.find((m) => m.t === "peer-joined"), "peer-joined control");

		guest.close();
		const left = await waitFor(() => bag.controls.find((m) => m.t === "peer-left"), "peer-left control");
		expect(left).toEqual({ t: "peer-left", peer: 1 });
	});

	test("host close orphans the room; a reconnecting host re-adopts and forwarding resumes", async () => {
		// Fresh relay: roomCount() below must reflect only this test's room.
		const { relay, baseUrl } = startRelayServer();
		const room = generateRoomId();
		const host1 = openRelaySocket(baseUrl, room, "host");
		await awaitOpen(host1);
		const guest = openRelaySocket(baseUrl, room, "guest");
		await awaitOpen(guest);
		collect(guest);

		host1.close();

		// The room survives as an orphan: the guest stays connected. The short
		// real wait is an absence-check that no close arrives.
		let guestClosed = false;
		guest.onclose = () => {
			guestClosed = true;
		};
		await sleep(100);
		expect(guestClosed).toBe(false);
		expect(relay.roomCount()).toBe(1);

		// …and a host reconnect within the TTL re-adopts it.
		const host2 = openRelaySocket(baseUrl, room, "host");
		await awaitOpen(host2);
		const bag = collect(host2);
		guest.send(makeEnvelope(0, PAYLOAD_A));
		const env = await waitFor(() => bag.binaries.shift(), "envelope forwarded after re-adoption");
		expect(envelopePeer(env)).toBe(1);
		expect(bytesEqual(new Uint8Array(env).slice(4), PAYLOAD_A)).toBe(true);

		relay.closeRoom(room);
	});

	// The relay owns the orphan timer (module-internal setTimeout), so this
	// exercises real timer behavior against the platform clock by design —
	// the contract mandates a short real TTL wait (orphanTtlMs: 100).
	test("orphan TTL expiry closes remaining guests with 4001", async () => {
		const { relay, baseUrl } = startRelayServer({ orphanTtlMs: 100 });
		const room = generateRoomId();
		const host = openRelaySocket(baseUrl, room, "host");
		await awaitOpen(host);
		const guest = openRelaySocket(baseUrl, room, "guest");
		await awaitOpen(guest);

		host.close();
		const ev = await awaitClose(guest);
		expect(ev.code).toBe(4001);
		expect(ev.reason).toBe("room closed");
		expect(relay.roomCount()).toBe(0);
	});

	test("closeRoom sends the room-closed control then closes guests with 4001", async () => {
		// Fresh relay: roomCount() below must reflect only this test's room.
		const { relay, baseUrl } = startRelayServer();
		const room = generateRoomId();
		const host = openRelaySocket(baseUrl, room, "host");
		await awaitOpen(host);
		const guest = openRelaySocket(baseUrl, room, "guest");
		await awaitOpen(guest);
		const bag = collect(guest);
		const closeP = awaitClose(guest);

		relay.closeRoom(room);

		const control = await waitFor(() => bag.controls.find((m) => m.t === "room-closed"), "room-closed control");
		expect(control).toEqual({ t: "room-closed" });
		const ev = await closeP;
		expect(ev.code).toBe(4001);
		expect(relay.roomCount()).toBe(0);

		// closeRoom leaves the host socket open (the adapter closes its own socket).
		expect(host.readyState).toBe(WebSocket.OPEN);
	});

	test("handleUpgrade returns false for non-/r paths and bad roles", async () => {
		const port = shared!.server.port;
		const httpBase = `http://127.0.0.1:${port}`;

		// Not a /r path at all.
		const res1 = await fetch(`${httpBase}/ws`);
		expect(res1.status).toBe(404);

		// /r path with a roomId that is too short.
		const res2 = await fetch(`${httpBase}/r/abc?role=host`);
		expect(res2.status).toBe(404);

		// /r path with an unknown role.
		const res3 = await fetch(`${httpBase}/r/${generateRoomId()}?role=admin`);
		expect(res3.status).toBe(404);
	});

	test("garbage binary frames and text frames are dropped", async () => {
		const base = shared!.baseUrl;
		const room = generateRoomId();
		const host = openRelaySocket(base, room, "host");
		await awaitOpen(host);
		const bag = collect(host);
		const guest = openRelaySocket(base, room, "guest");
		await awaitOpen(guest);
		await waitFor(() => bag.controls.find((m) => m.t === "peer-joined"), "peer-joined control");

		// TEXT frames from a client are ignored entirely.
		guest.send("garbage text frame");
		// Binary frames shorter than the 4-byte envelope header are dropped.
		guest.send(new Uint8Array([1, 2]));
		guest.send(new Uint8Array([1, 2, 3]));
		// Short real wait is an absence-check that nothing was forwarded.
		await sleep(50);

		expect(bag.controls).toEqual([{ t: "peer-joined", peer: 1 }]);
		expect(bag.binaries.length).toBe(0);

		// A well-formed envelope still flows (only the garbage was dropped).
		guest.send(makeEnvelope(0, PAYLOAD_A));
		const env = await waitFor(() => bag.binaries.shift(), "valid envelope forwarded");
		expect(envelopePeer(env)).toBe(1);
		expect(bytesEqual(new Uint8Array(env).slice(4), PAYLOAD_A)).toBe(true);
	});
});
