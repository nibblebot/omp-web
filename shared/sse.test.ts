import { describe, expect, test } from "bun:test";
import { encodeSseEvent, parseSseUnits, SSE_PING_BLOCK, SseRing, type SseUnit } from "./sse";

function streamFrom(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
}

async function collect(chunks: string[]): Promise<SseUnit[]> {
	const units: SseUnit[] = [];
	for await (const unit of parseSseUnits(streamFrom(chunks))) units.push(unit);
	return units;
}

describe("encodeSseEvent", () => {
	test("emits event/id/data fields terminated by a blank line", () => {
		expect(encodeSseEvent("frame", { type: "ready", readyAt: 1 }, 7)).toBe(
			'event: frame\nid: 7\ndata: {"type":"ready","readyAt":1}\n\n',
		);
	});
});

describe("parseSseUnits", () => {
	test("round-trips encoded events", async () => {
		const block = encodeSseEvent("frame", { type: "ready", readyAt: 1 }, 7);
		const units = await collect([block]);
		expect(units).toEqual([
			{ kind: "event", event: "frame", id: "7", data: '{"type":"ready","readyAt":1}' },
		]);
	});

	test("reassembles events split across chunks", async () => {
		const block = encodeSseEvent("frame", { a: "bcdef" }, 3);
		const units = await collect([block.slice(0, 5), block.slice(5, 21), block.slice(21)]);
		expect(units).toEqual([{ kind: "event", event: "frame", id: "3", data: '{"a":"bcdef"}' }]);
	});

	test("parses the keepalive ping block as an id-less event", async () => {
		const units = await collect([SSE_PING_BLOCK, encodeSseEvent("frame", {}, 1)]);
		expect(units[0]).toEqual({ kind: "event", event: "ping", id: undefined, data: "{}" });
		expect(units[1].kind).toBe("event");
	});

	test("still surfaces comment lines per the SSE spec", async () => {
		const units = await collect([": ping\n\n"]);
		expect(units).toEqual([{ kind: "comment", text: "ping" }]);
	});

	test("joins multi-line data and tolerates CRLF", async () => {
		const units = await collect(['event: frame\r\nid: 9\r\ndata: {"a":\r\ndata: 1}\r\n\r\n']);
		expect(units).toEqual([{ kind: "event", event: "frame", id: "9", data: '{"a":\n1}' }]);
	});

	test("yields an unterminated trailing event at end of body", async () => {
		const units = await collect(["event: frame\nid: 2\ndata: {}\n"]);
		expect(units).toEqual([{ kind: "event", event: "frame", id: "2", data: "{}" }]);
	});
});

describe("SseRing", () => {
	test("evicts oldest beyond cap", () => {
		const ring = new SseRing<number>(3);
		for (let seq = 1; seq <= 5; seq++) ring.push(seq, seq * 10);
		expect(ring.size).toBe(3);
		expect(ring.after(0).map((e) => e.seq)).toEqual([3, 4, 5]);
	});

	test("after returns only newer entries, oldest first", () => {
		const ring = new SseRing<string>(10);
		for (let seq = 10; seq <= 14; seq++) ring.push(seq, `s${seq}`);
		expect(ring.after(12).map((e) => [e.seq, e.value])).toEqual([
			[13, "s13"],
			[14, "s14"],
		]);
		expect(ring.after(14)).toEqual([]);
	});

	test("byte budget evicts oldest entries from the head (finding #5)", () => {
		const ring = new SseRing<string>(100, 30);
		ring.push(1, "a".repeat(8)); // 8
		ring.push(2, "b".repeat(8)); // 16
		ring.push(3, "c".repeat(10)); // 26
		ring.push(4, "d".repeat(10)); // 36 > 30 → evict entry 1 (8) → 28
		expect(ring.size).toBe(3);
		expect(ring.bytes).toBe(28);
		expect(ring.after(0).map((e) => e.seq)).toEqual([2, 3, 4]);
	});

	test("a single entry larger than the whole budget still lands", () => {
		const ring = new SseRing<string>(10, 10);
		ring.push(1, "small"); // 5
		ring.push(2, "x".repeat(100)); // 100 > 10 → evicts entry 1, keeps the newest
		expect(ring.size).toBe(1);
		expect(ring.after(0).map((e) => e.seq)).toEqual([2]);
	});

	test("entry cap stays a secondary bound after byte eviction", () => {
		const ring = new SseRing<string>(3, 1_000_000);
		for (let seq = 1; seq <= 5; seq++) ring.push(seq, `s${seq}`);
		expect(ring.size).toBe(3);
		expect(ring.after(0).map((e) => e.seq)).toEqual([3, 4, 5]);
	});

	test("after() stays correct across byte eviction (replay skips evicted, keeps newer)", () => {
		const ring = new SseRing<string>(100, 50);
		ring.push(1, "a".repeat(30));
		ring.push(2, "b".repeat(30)); // 60 > 50 → evict 1
		ring.push(3, "c".repeat(30)); // 60 > 50 → evict 2
		// Eviction left a gap, but after() is still correct: it returns every
		// RINGED entry newer than the id (missing ones are re-derivable —
		// drop-and-resume, never a corrupted tail).
		expect(ring.after(1).map((e) => e.seq)).toEqual([3]);
		expect(ring.after(2).map((e) => e.seq)).toEqual([3]);
		ring.push(4, "d".repeat(10)); // 40 ≤ 50
		expect(ring.after(2).map((e) => e.seq)).toEqual([3, 4]);
		expect(ring.after(3).map((e) => e.seq)).toEqual([4]);
		expect(ring.after(4)).toEqual([]);
	});
});
