/**
 * Outbound wire encoding: the daemon serializes each payload once (or takes the
 * sender's PreEncodedPayload) and assembles the text message around it. The
 * message on the wire must stay exactly what a whole-envelope JSON.stringify
 * produced, the 1 MiB envelope cap must still be judged against that canonical
 * size, and one pre-serialized payload must serve several streams under their
 * own seqs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	decodeEnvelope,
	preEncodePayload,
	type CallbackEnvelope,
} from "#lib/wire/callback-protocol";
import { FleetCallback } from "../fleet-callback";
import { startFakeFleet, type FakeFleet } from "./fake-fleet.testkit";

const WORKSPACE = "ws-encoding";
const GENERATION = 2;
const TOKEN = "b".repeat(64);

const fleets: FakeFleet[] = [];
const callbacks: FleetCallback[] = [];
afterAll(() => {
	for (const callback of callbacks) callback.stop();
	for (const fleet of fleets) fleet.stop();
});

async function startPair(extra: { maxEnvelopeBytes?: number } = {}): Promise<{
	fleet: FakeFleet;
	callback: FleetCallback;
}> {
	const fleet = startFakeFleet({ workspaceId: WORKSPACE, generation: GENERATION, token: TOKEN });
	fleets.push(fleet);
	const callback = new FleetCallback({
		url: fleet.url,
		workspaceId: WORKSPACE,
		generation: GENERATION,
		token: TOKEN,
		allowHttp: true,
		...extra,
	});
	callbacks.push(callback);
	await callback.start();
	return { fleet, callback };
}

const DELTA = {
	type: "event",
	event: {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: 'é日本 "q"\n\u{1F600}' },
	},
};

describe("FleetCallback outbound encoding", () => {
	test("raw and pre-serialized payloads reach the wire as canonical envelope messages under per-stream seqs", async () => {
		const { fleet, callback } = await startPair();
		const shared = preEncodePayload(DELTA);
		expect(callback.send({ streamId: "control", kind: "frame", payload: shared })).toBe("sent");
		expect(callback.send({ streamId: "browser/a", kind: "frame", payload: shared })).toBe("sent");
		expect(callback.send({ streamId: "browser/b", kind: "frame", payload: DELTA })).toBe("sent");
		expect(callback.send({ streamId: "browser/a", kind: "control", payload: { type: "x" } })).toBe(
			"sent",
		);
		await fleet.whenReceived(4);

		const envelopes: CallbackEnvelope[] = fleet.raw.slice(0, 4).map((text) => {
			const envelope = decodeEnvelope(text);
			// The message is exactly what whole-envelope serialization yields.
			expect(text).toBe(JSON.stringify(envelope));
			return envelope;
		});
		expect(envelopes.map((e) => e.streamId)).toEqual([
			"control",
			"browser/a",
			"browser/b",
			"browser/a",
		]);
		expect(envelopes.map((e) => e.kind)).toEqual(["frame", "frame", "frame", "control"]);
		expect(envelopes.slice(0, 3).map((e) => e.payload)).toEqual([DELTA, DELTA, DELTA]);
		expect(envelopes[3]!.payload).toEqual({ type: "x" });
		// Each emit stamps its own monotonic seq and the live pair's identity.
		const seqs = envelopes.map((e) => e.seq);
		expect(seqs).toEqual([seqs[0]!, seqs[0]! + 1, seqs[0]! + 2, seqs[0]! + 3]);
		expect(new Set(envelopes.map((e) => e.connectionId)).size).toBe(1);
		for (const e of envelopes) {
			expect(e.version).toBe(2);
			expect(e.workspaceId).toBe(WORKSPACE);
			expect(e.generation).toBe(GENERATION);
		}
	});

	test("the envelope cap is judged against the canonical serialized size, to the byte", async () => {
		const payload = { type: "state", text: "é日本".repeat(40) };
		// Size of the envelope the first send will emit: seq 1 on the live pair.
		const probe = await startPair();
		const connectionId = probe.callback.status().connectionId!;
		const canonical = Buffer.byteLength(
			JSON.stringify({
				version: 2,
				workspaceId: WORKSPACE,
				generation: GENERATION,
				connectionId,
				streamId: "browser/a",
				seq: 1,
				kind: "frame",
				payload,
				at: Date.now(),
			}),
			"utf8",
		);

		const fits = await startPair({ maxEnvelopeBytes: canonical });
		expect(
			fits.callback.send({
				streamId: "browser/a",
				kind: "frame",
				payload: preEncodePayload(payload),
			}),
		).toBe("sent");
		await fits.fleet.whenReceived(1);

		const over = await startPair({ maxEnvelopeBytes: canonical - 1 });
		expect(over.callback.send({ streamId: "browser/a", kind: "frame", payload })).toBe("rejected");
		expect(
			over.callback.send({
				streamId: "browser/a",
				kind: "frame",
				payload: preEncodePayload(payload),
			}),
		).toBe("rejected");
		expect(over.callback.status().rejected).toBe(2);
	});

	test("an unserializable payload is rejected and the queue keeps flowing", async () => {
		const { fleet, callback } = await startPair();
		expect(callback.send({ streamId: "browser/a", kind: "frame", payload: { n: 1n } })).toBe(
			"rejected",
		);
		expect(callback.send({ streamId: "browser/a", kind: "frame", payload: undefined })).toBe(
			"rejected",
		);
		expect(callback.send({ streamId: "browser/a", kind: "frame", payload: DELTA })).toBe("sent");
		await fleet.whenReceived(1);
		expect(decodeEnvelope(fleet.raw[0]!).payload).toEqual(DELTA);
	});

	test("an envelope exactly at the 1 MiB cap goes out as one text message", async () => {
		const { fleet, callback } = await startPair();
		const connectionId = callback.status().connectionId!;
		const frame = (text: string): string =>
			JSON.stringify({
				version: 2,
				workspaceId: WORKSPACE,
				generation: GENERATION,
				connectionId,
				streamId: "browser/a",
				seq: 1,
				kind: "frame",
				payload: { text },
				at: 1_000_000_000_000,
			});
		const overhead = Buffer.byteLength(frame(""), "utf8");
		const text = "x".repeat(1024 * 1024 - overhead);
		expect(callback.send({ streamId: "browser/a", kind: "frame", payload: { text } })).toBe("sent");
		await fleet.whenReceived(1);
		expect(Buffer.byteLength(fleet.raw[0]!, "utf8")).toBe(1024 * 1024);
		expect(decodeEnvelope(fleet.raw[0]!).payload).toEqual({ text });
	});
});
