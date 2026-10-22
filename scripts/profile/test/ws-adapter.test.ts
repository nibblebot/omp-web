import { afterEach, expect, test } from "bun:test";
import { BROWSER_CLOSE, browserCloseFor } from "#lib/wire/browser-socket";
import { OMP_PROTO } from "#lib/wire/protocol";
import { wsAdapter } from "../adapters/ws";
import { ProfileClient } from "../client";
import { FakeFleet, type Frame } from "./fake-fleet";

/**
 * The `ws` adapter and the ProfileClient measurements on top of it, against the fake `/ws`
 * fleet in ./fake-fleet.ts (which implements exactly what adapters/ws.ts says it expects).
 */

let fleet: FakeFleet | undefined;
let client: ProfileClient | undefined;

afterEach(async () => {
	await client?.close();
	await fleet?.stop();
	client = undefined;
	fleet = undefined;
});

const textDelta = (delta: string): Frame => ({
	type: "event",
	event: {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	},
});

test("dials /ws with client, proto and no after; the fingerprint label is ws", async () => {
	fleet = new FakeFleet();
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl, { resilient: false });
	await fleet.connected();
	expect(wsAdapter.name).toBe("ws");
	expect(fleet.dials).toEqual([{ client: client.clientId, after: null, proto: OMP_PROTO }]);
});

test("frames carry their seq, receive stamps, message bytes; pings are skipped but counted", async () => {
	fleet = new FakeFleet();
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl, { resilient: false });
	await fleet.connected();
	const seen: Array<{ type: string; seq: number | undefined; bytes: number; recvNs: bigint }> = [];
	client.onFrame((r) =>
		seen.push({ type: r.frame.type, seq: r.seq, bytes: r.bytes, recvNs: r.recvNs }),
	);
	const arrived = client.waitFrame((r) => r.frame.type === "marker", 5_000, "marker");
	fleet.push({ type: "roster" }, { type: "marker" });
	await arrived;
	expect(seen.map((s) => s.type)).toEqual(["roster", "marker"]);
	expect(seen.map((s) => s.seq)).toEqual([1, 2]);
	expect(seen[0]!.bytes).toBe(Buffer.byteLength('{"seq":1,"frame":{"type":"roster"}}'));
	expect(seen[1]!.recvNs >= seen[0]!.recvNs).toBe(true);
	// The ping the fake sends on open is in bytesDown but is not a frame.
	expect(client.frames).toBe(2);
	expect(client.frameBytes).toBe(
		Buffer.byteLength('{"seq":1,"frame":{"type":"roster"}}') +
			Buffer.byteLength('{"seq":2,"frame":{"type":"marker"}}'),
	);
	expect(client.bytesDown).toBeGreaterThan(client.frameBytes);
});

test("call RTT runs to the call_result frame, not to the ack", async () => {
	fleet = new FakeFleet();
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl, { resilient: false });
	const call = client.call("slow", [], 5_000);
	const sent = await fleet.command(1);
	// The ack went out at once; hold the answer back and check the call is still waiting.
	await client.send({ type: "call", id: "barrier", method: "ping", args: [] });
	expect(await Promise.race([call, Promise.resolve("pending")])).toBe("pending");
	fleet.push({ type: "call_result", id: sent.id, ok: true, data: 7 });
	const result = await call;
	expect(result).toMatchObject({ ok: true, data: 7 });
	expect(result.rttMs).toBeGreaterThanOrEqual(result.acceptMs);
});

test("a nack rejects the send with its status; commands without an id are refused locally", async () => {
	fleet = new FakeFleet({
		nack: (c) => (c.method === "big" ? { status: 413, error: "too large" } : undefined),
	});
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl, { resilient: false });
	await expect(client.send({ type: "call", id: "a", method: "big", args: [] })).rejects.toThrow(
		"nacked 413: too large",
	);
	await expect(client.send({ type: "call", method: "ping", args: [] })).rejects.toThrow(
		"string id",
	);
	await client.send({ type: "call", id: "b", method: "ping", args: [] });
});

test("a re-sent id is acked again", async () => {
	fleet = new FakeFleet();
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl, { resilient: false });
	const command = { type: "call", id: "same", method: "noop", args: [] };
	await Promise.all([client.send(command), client.send(command)]);
	await client.send(command);
	expect(fleet.commands.map((c) => c.id)).toEqual(["same", "same", "same"]);
});

test("a typed close ends the connection with its code; 4503 is a drop the client recovers from with after", async () => {
	fleet = new FakeFleet({ autoAttach: true });
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl);
	await client.attach("d1", "s1", 5_000);
	fleet.push(textDelta("hello"));
	const lastSeq = fleet.lastSeq;
	await client.waitFrame((r) => r.seq === lastSeq, 5_000, "last frame");

	const { code, reason } = browserCloseFor("slow_consumer", "buffered over the cap");
	fleet.closeSocket(code, reason);
	await client.ended;

	// The resilient client redials with after=<last seq seen> and re-attaches.
	await fleet.command(2);
	expect(fleet.dials).toHaveLength(2);
	expect(fleet.dials[1]).toEqual({ client: client.clientId, after: lastSeq, proto: OMP_PROTO });
	await client.waitFrame(
		(r) => r.frame.type === "available_commands" && r.seq !== undefined && r.seq > lastSeq,
		5_000,
		"re-primed",
	);
	expect(client.dropLog).toHaveLength(1);
	expect(client.dropLog[0]).toMatchObject({ how: "closed" });
	expect(client.dropLog[0]?.close).toContain("4503");
});

test("a non-resilient client fails waiters with the close code", async () => {
	fleet = new FakeFleet();
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl, { resilient: false });
	await fleet.connected();
	const waiting = client.waitFrame(() => false, 5_000, "never");
	fleet.closeSocket(BROWSER_CLOSE.slow_consumer, "slow_consumer: test");
	await expect(waiting).rejects.toThrow(/socket closed unexpectedly \(closed, 4503/);
});

test("reconnect(): drops the socket, redials with after, re-attaches and reports the resume timings", async () => {
	fleet = new FakeFleet({ autoAttach: true });
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl);
	await client.attach("d1", "s1", 5_000);
	const before = fleet.lastSeq;
	const timings = await client.reconnect("d1", "s1");
	expect(fleet.dials.at(-1)).toEqual({ client: client.clientId, after: before, proto: OMP_PROTO });
	// The re-attach primed fresh frames beyond everything seen before the drop.
	expect(timings.resumeMs).toBeGreaterThanOrEqual(timings.openMs);
	expect(timings.reattachPrimedMs).toBeGreaterThanOrEqual(timings.firstFrameMs);
	expect(timings.replayFrames).toBeGreaterThan(0);
	// A client-initiated drop is not an unexpected end.
	expect(client.dropLog).toHaveLength(0);
});

test("an upgrade followed by a typed refusal opens, then ends with the code", async () => {
	const refusal = browserCloseFor("proto_mismatch", "server speaks another proto");
	fleet = new FakeFleet({ refuse: refusal });
	const conn = await wsAdapter.open({ baseUrl: fleet.baseUrl, clientId: "c" });
	expect(await conn.ended).toBe("closed");
	expect(conn.closeInfo).toContain("4426");
	await expect(conn.send({ type: "call", id: "x", method: "ping" })).rejects.toThrow("not open");
});

test("a dial the server does not upgrade rejects open()", async () => {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("no", { status: 426 }),
	});
	try {
		await expect(
			wsAdapter.open({ baseUrl: `http://127.0.0.1:${server.port}`, clientId: "c" }),
		).rejects.toThrow("GET /ws failed");
	} finally {
		await server.stop(true);
	}
});

test("an unparseable server message closes 4400 and ends as an error", async () => {
	fleet = new FakeFleet();
	const conn = await wsAdapter.open({ baseUrl: fleet.baseUrl, clientId: "c" });
	await fleet.connected();
	fleet.pushRaw("not json");
	expect(await conn.ended).toBe("error");
	expect(conn.closeInfo).toContain(String(BROWSER_CLOSE.protocol_violation));
});

test("drop() terminates without a goodbye and reports dropped", async () => {
	fleet = new FakeFleet();
	const conn = await wsAdapter.open({ baseUrl: fleet.baseUrl, clientId: "c" });
	conn.drop();
	expect(await conn.ended).toBe("dropped");
});
