import { describe, expect, test } from "bun:test";
import {
	encodeSseEvent,
	parseSseUnits,
	SSE_MAX_LINE_CHARS,
	SSE_PING_BLOCK,
	type SseUnit,
} from "#lib/wire/sse";

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
		// Literal wire bytes (the encoder's shape is pinned by the tests above);
		// only the chunk boundaries matter here.
		const block = 'event: frame\nid: 3\ndata: {"a":"bcdef"}\n\n';
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

describe("parseSseUnits limits", () => {
	test("reassembles a 1 MB data line delivered in 1 KB chunks", async () => {
		const data = "x".repeat(1_000_000);
		const block = encodeSseEvent("frame", data, 1);
		const chunks: string[] = [];
		for (let offset = 0; offset < block.length; offset += 1024) {
			chunks.push(block.slice(offset, offset + 1024));
		}
		const units = await collect(chunks);
		expect(units).toEqual([{ kind: "event", event: "frame", id: "1", data: JSON.stringify(data) }]);
	});

	test("fails the stream when one line exceeds SSE_MAX_LINE_CHARS without a newline", async () => {
		const oversize = "x".repeat(SSE_MAX_LINE_CHARS + 1);
		await expect(collect(["data: ", oversize])).rejects.toThrow(/without a newline/);
	});
});
