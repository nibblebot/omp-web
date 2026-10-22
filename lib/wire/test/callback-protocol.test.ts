import { describe, expect, test } from "bun:test";
import {
	CALLBACK_WS_MAX_PAYLOAD_BYTES,
	CONNECTION_MAX_BYTES,
	CallbackError,
	type CallbackEnvelope,
	callbackCloseFor,
	callbackErrorFromClose,
	canonicalPayloadJson,
	codeFromHttpStatus,
	decodeEnvelope,
	ENVELOPE_MAX_BYTES,
	encodeEnvelopeAround,
	envelopeFraming,
	needsSplit,
	isPairCreditControl,
	OMP_CALLBACK_PROTO,
	PAIR_CREDIT_STEP_BYTES,
	PAIR_CREDIT_WINDOW_BYTES,
	planOversizeSplit,
	preEncodePayload,
	reassembleChunks,
	validateEnvelope,
} from "#lib/wire/callback-protocol";

describe("validateEnvelope precomputed bytes", () => {
	const envelope = {
		version: OMP_CALLBACK_PROTO,
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

	test("refuses a proto-1 envelope", () => {
		expect(() => validateEnvelope({ ...envelope, version: 1 })).toThrow(CallbackError);
	});
});

describe("encodeEnvelopeAround", () => {
	const head = {
		version: OMP_CALLBACK_PROTO,
		workspaceId: 'ws-"quoted"\n',
		generation: 3,
		connectionId: "00000000-0000-4000-8000-000000000000",
		streamId: "browser/conn-é",
		seq: 4242,
		kind: "frame",
		at: 1_700_000_000_123,
	} as const;
	/** The envelope as producers build it: payload before `at`, the canonical key order. */
	const envelopeOf = (
		payload: unknown,
		from: typeof head | typeof plainHead = head,
	): CallbackEnvelope => ({
		version: from.version,
		workspaceId: from.workspaceId,
		generation: from.generation,
		connectionId: from.connectionId,
		streamId: from.streamId,
		seq: from.seq,
		kind: from.kind,
		payload,
		at: from.at,
	});
	const plainHead = { ...head, workspaceId: "ws-plain", streamId: "browser/conn-1" };
	const payloads: Array<[string, unknown]> = [
		["a delta frame", { type: "event", event: { type: "message_update", delta: "hi" } }],
		[
			"escapes and non-ASCII",
			{ type: "event", text: 'line\n"q"\\ é 日本 \u{1F600} \u2028 \u0007' },
		],
		["a lone surrogate", { type: "event", text: "\ud800 tail" }],
		["null", null],
		["a bare string", "text"],
		["nested arrays", { a: [1, [2, { b: null }], "x"], c: {} }],
	];

	test.each(payloads)("equals JSON.stringify of the envelope for %s", (_name, payload) => {
		const encoded = preEncodePayload(payload);
		const message = encodeEnvelopeAround(head, encoded.json);
		expect(message).toBe(JSON.stringify(envelopeOf(payload)));
		expect(encoded.bytes).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
		const decoded = decodeEnvelope(message, Buffer.byteLength(message, "utf8"));
		expect(decoded.payload).toEqual(JSON.parse(JSON.stringify(payload)));
	});

	test.each(payloads)(
		"canonicalPayloadJson returns the payload's own text for %s",
		(_name, payload) => {
			const json = preEncodePayload(payload).json;
			const message = encodeEnvelopeAround(head, json);
			expect(canonicalPayloadJson(message, decodeEnvelope(message))).toBe(json);
		},
	);

	test("canonicalPayloadJson keeps a payload's own whitespace and duplicate keys verbatim", () => {
		const text = '{"type": "history",\n "type":"daemons", "n":[ 1 ]}';
		const message = encodeEnvelopeAround(head, text);
		const envelope = decodeEnvelope(message);
		expect(canonicalPayloadJson(message, envelope)).toBe(text);
		expect(envelope.payload).toEqual({ type: "daemons", n: [1] });
	});

	test("canonicalPayloadJson treats whitespace right after the payload key as part of the payload text", () => {
		const json = preEncodePayload({ type: "state" }).json;
		const message = encodeEnvelopeAround(plainHead, ` ${json}`);
		expect(canonicalPayloadJson(message, decodeEnvelope(message))).toBe(` ${json}`);
	});

	test("canonicalPayloadJson declines padded, pretty-printed and re-keyed framing", () => {
		const json = preEncodePayload({ type: "state" }).json;
		const canonical = encodeEnvelopeAround(plainHead, json);
		const decline = (message: string): void =>
			expect(canonicalPayloadJson(message, decodeEnvelope(message))).toBeUndefined();
		decline(canonical.replace('"payload":', '"payload" :'));
		decline(canonical.replace(',"at":', ', "at":'));
		decline(` ${canonical}`);
		decline(`${canonical} `);
		decline(JSON.stringify(envelopeOf({ type: "state" }, plainHead), null, 1));
		const { payload, ...rest } = envelopeOf({ type: "state" }, plainHead);
		decline(JSON.stringify({ payload, ...rest }));
		decline(canonical.replace('"workspaceId":"ws-plain"', '"workspaceId":"ws\\u002dplain"'));
	});

	test("plain-ASCII identity fields encode identically to JSON.stringify", () => {
		const payload = { type: "state" };
		const message = encodeEnvelopeAround(plainHead, preEncodePayload(payload).json);
		expect(message).toBe(JSON.stringify(envelopeOf(payload, plainHead)));
	});

	test("framing plus payload bytes is the envelope's canonical size", () => {
		const payload = { type: "state", state: { blob: "é".repeat(1000) } };
		const encoded = preEncodePayload(payload);
		const { head: front, tail } = envelopeFraming(head);
		const size = Buffer.byteLength(front, "utf8") + encoded.bytes + Buffer.byteLength(tail, "utf8");
		expect(size).toBe(Buffer.byteLength(JSON.stringify(envelopeOf(payload)), "utf8"));
	});

	test("every slice of a chunked oversized payload encodes identically and reassembles", () => {
		const payload = { type: "history", messages: ["é日本".repeat(500_000)] };
		const source = envelopeOf(payload);
		expect(needsSplit(source)).toBe(true);
		const split = planOversizeSplit(source);
		expect(split.total).toBeGreaterThan(1);
		for (const slice of split.envelopes) {
			const { payload: slicePayload, ...sliceHead } = slice;
			const message = encodeEnvelopeAround(sliceHead, preEncodePayload(slicePayload).json);
			expect(message).toBe(JSON.stringify(slice));
			expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(ENVELOPE_MAX_BYTES);
		}
		expect(reassembleChunks(split.envelopes)).toEqual(payload);
	});

	test("preEncodePayload refuses a missing payload and an unserializable one", () => {
		expect(() => preEncodePayload(undefined)).toThrow(CallbackError);
		expect(() => preEncodePayload({ n: 1n })).toThrow(TypeError);
	});
});

describe("decodeEnvelope", () => {
	const message = JSON.stringify({
		version: OMP_CALLBACK_PROTO,
		workspaceId: "ws",
		generation: 1,
		connectionId: "c",
		streamId: "control",
		seq: 1,
		kind: "frame",
		payload: { blob: "x".repeat(ENVELOPE_MAX_BYTES) },
		at: 1,
	});

	test("enforces the cap on the canonical form when the wire length is over it", () => {
		expect(() => decodeEnvelope(message, Buffer.byteLength(message, "utf8"))).toThrow(
			CallbackError,
		);
		expect(() => decodeEnvelope(message)).toThrow(CallbackError);
	});

	test("refuses a message that is not JSON", () => {
		expect(() => decodeEnvelope("{")).toThrow(CallbackError);
	});
});

describe("pair-socket refusal close codes", () => {
	test("round-trips a ledger code through a close frame", () => {
		const close = callbackCloseFor(new CallbackError("generation_obsolete", "superseded"));
		expect(close).toEqual({ code: 4409, reason: "generation_obsolete: superseded" });
		const back = callbackErrorFromClose(close.code, close.reason);
		expect(back?.code).toBe("generation_obsolete");
		expect(back?.message).toBe("superseded");
	});

	test("cuts the reason to 123 bytes without splitting a character", () => {
		const close = callbackCloseFor(new CallbackError("unauthorized", "é".repeat(200)));
		expect(Buffer.byteLength(close.reason, "utf8")).toBeLessThanOrEqual(123);
		expect(close.reason).not.toContain("\uFFFD");
		expect(callbackErrorFromClose(close.code, close.reason)?.code).toBe("unauthorized");
	});

	test("an ordinary close is not a refusal", () => {
		expect(callbackErrorFromClose(1000, "")).toBeNull();
		expect(callbackErrorFromClose(1006, "unauthorized: x")).toBeNull();
		expect(callbackErrorFromClose(5000, "unauthorized: x")).toBeNull();
	});

	test("an untyped refusal reason falls back to the status", () => {
		expect(callbackErrorFromClose(4401, "denied")?.code).toBe("unauthorized");
		expect(callbackErrorFromClose(4599, "")?.code).toBe("retryable");
	});

	test("proto_unsupported reads as generation_obsolete to a client that does not know the code", () => {
		const close = callbackCloseFor(new CallbackError("proto_unsupported", "proto 1"));
		expect(close.code).toBe(4410);
		expect(codeFromHttpStatus(close.code - 4000)).toBe("generation_obsolete");
	});
});

describe("pair upload credit", () => {
	test("the window admits a maximal socket-legal message beside the ungranted tail of one grant step", () => {
		expect(PAIR_CREDIT_WINDOW_BYTES - PAIR_CREDIT_STEP_BYTES).toBeGreaterThanOrEqual(
			CALLBACK_WS_MAX_PAYLOAD_BYTES,
		);
		expect(CALLBACK_WS_MAX_PAYLOAD_BYTES).toBeGreaterThanOrEqual(ENVELOPE_MAX_BYTES);
		// The daemon's own queue cap: a full queue never waits on more than it can hold.
		expect(PAIR_CREDIT_WINDOW_BYTES).toBe(CONNECTION_MAX_BYTES);
	});

	test("isPairCreditControl takes a cumulative non-negative safe integer only", () => {
		expect(isPairCreditControl({ type: "pair_credit", consumed: 0 })).toBe(true);
		expect(isPairCreditControl({ type: "pair_credit", consumed: 512 * 1024 })).toBe(true);
		expect(isPairCreditControl({ type: "pair_credit", consumed: -1 })).toBe(false);
		expect(isPairCreditControl({ type: "pair_credit", consumed: 1.5 })).toBe(false);
		expect(
			isPairCreditControl({ type: "pair_credit", consumed: Number.MAX_SAFE_INTEGER + 1 }),
		).toBe(false);
		expect(isPairCreditControl({ type: "pair_credit", consumed: "10" })).toBe(false);
		expect(isPairCreditControl({ type: "stream_ack", consumed: 10 })).toBe(false);
		expect(isPairCreditControl({ type: "pair_credit" })).toBe(false);
		expect(isPairCreditControl(null)).toBe(false);
		expect(isPairCreditControl("pair_credit")).toBe(false);
	});
});
