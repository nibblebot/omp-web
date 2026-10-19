import { describe, expect, test } from "bun:test";
import { CallbackError, createNdjsonParser, validateEnvelope } from "#lib/wire/callback-protocol";

// Record strings for emitted items; dropped items map to the marker "dropped".
function summarize(items: readonly object[]): unknown[] {
	return items.map((item) => ("record" in item ? item.record : "dropped"));
}

describe("createNdjsonParser", () => {
	test("drops an over-cap record and resumes at the next newline", () => {
		const parser = createNdjsonParser({ maxRecordBytes: 8 });
		expect(summarize(parser.push("123456789012\nok\n"))).toEqual(["dropped", "ok"]);
	});

	test("discards the rest of an over-cap record that spans chunks", () => {
		const parser = createNdjsonParser({ maxRecordBytes: 8 });
		expect(parser.push("123456")).toEqual([]);
		expect(summarize(parser.push("789012345"))).toEqual(["dropped"]);
		expect(summarize(parser.push("6\nok\n"))).toEqual(["ok"]);
	});

	test("keeps a multi-byte character split across chunks intact", () => {
		const bytes = new TextEncoder().encode('{"t":"é"}\n');
		const parser = createNdjsonParser();
		// The split lands inside the two-byte "é" (bytes 6 and 7).
		expect(parser.push(bytes.subarray(0, 7))).toEqual([]);
		expect(summarize(parser.push(bytes.subarray(7)))).toEqual(['{"t":"é"}']);
	});
});

describe("validateEnvelope precomputed bytes", () => {
	const envelope = {
		version: 1,
		workspaceId: "ws-test",
		generation: 1,
		connectionId: "00000000-0000-4000-8000-000000000000",
		streamId: "stream/settings",
		seq: 1,
		kind: "frame",
		payload: { type: "ready" },
		at: 1,
	};

	test("accepts a supplied byte count within the cap", () => {
		const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
		expect(() => validateEnvelope(envelope, { maxBytes: 1 << 20, bytes })).not.toThrow();
	});

	test("enforces the cap against the supplied byte count", () => {
		expect(() => validateEnvelope(envelope, { maxBytes: 1 << 20, bytes: (1 << 20) + 1 })).toThrow(
			CallbackError,
		);
	});
});
