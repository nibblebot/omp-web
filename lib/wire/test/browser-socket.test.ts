import { describe, expect, test } from "bun:test";
import {
	ackMessage,
	BROWSER_CLOSE,
	browserCloseFor,
	browserCloseFromCode,
	browserSocketUrl,
	commandMessage,
	frameMessage,
	nackMessage,
	parseBrowserSocketParams,
	parseClientMessage,
	parseServerMessage,
	pingMessage,
	reconnectDelayMs,
	seqFrameMessage,
} from "#lib/wire/browser-socket";
import { MAX_COMMAND_BYTES } from "#lib/wire/command-limits";
import { OMP_PROTO, type ClientCommand, type ServerFrame } from "#lib/wire/protocol";

const bytesOf = (text: string) => Buffer.byteLength(text, "utf8");

describe("server messages", () => {
	const frame = {
		type: "event",
		event: { type: "message_update", text: 'quote " newline \n tab \t unicode é 🙂' },
		sessionId: "d1",
	};
	const frameJson = JSON.stringify(frame);

	test("a spliced sequenced frame parses to the same object as stringifying the wrapper", () => {
		expect(JSON.parse(seqFrameMessage(1030, frameJson))).toEqual(
			JSON.parse(JSON.stringify({ seq: 1030, frame })),
		);
		expect(seqFrameMessage(1030, frameJson)).toBe(JSON.stringify({ seq: 1030, frame }));
	});

	test("a spliced unsequenced frame parses to the same object as stringifying the wrapper", () => {
		expect(frameMessage(frameJson)).toBe(JSON.stringify({ frame }));
	});

	test("a relayed frame with insignificant whitespace still splices to the same value", () => {
		const relayed = '{ "type" : "event",\n "event" : {"type":"agent_end"} }';
		expect(parseServerMessage(seqFrameMessage(7, relayed))).toEqual({
			kind: "frame",
			seq: 7,
			frame: { type: "event", event: { type: "agent_end" } } as ServerFrame,
		});
	});

	test("every builder round-trips through parseServerMessage", () => {
		expect(parseServerMessage(frameMessage(frameJson))).toEqual({
			kind: "frame",
			seq: null,
			frame: frame as ServerFrame,
		});
		expect(parseServerMessage(pingMessage(1234))).toEqual({ kind: "ping", at: 1234 });
		expect(parseServerMessage(ackMessage('a"b'))).toEqual({ kind: "ack", id: 'a"b' });
		expect(parseServerMessage(nackMessage("c1", 413, "too big"))).toEqual({
			kind: "nack",
			id: "c1",
			status: 413,
			error: "too big",
		});
	});

	test.each([
		["binary", new Uint8Array([123, 125])],
		["not JSON", "{"],
		["array", "[]"],
		["unknown shape", '{"hello":1}'],
		["frame without type", '{"frame":{}}'],
		["frame not an object", '{"frame":"x"}'],
		["zero seq", '{"seq":0,"frame":{"type":"x"}}'],
		["fractional seq", '{"seq":1.5,"frame":{"type":"x"}}'],
		["string ack", '{"ack":1}'],
		["nack without status", '{"nack":"a"}'],
	])("rejects %s", (_label, data) => {
		expect(parseServerMessage(data)).toBeNull();
	});
});

describe("client messages", () => {
	const command: ClientCommand = { type: "call", id: "c1", method: "prompt", args: ["hé"] };

	test("a command message parses back with its forwarded byte count", () => {
		const text = commandMessage(command);
		const parsed = parseClientMessage(text, bytesOf(text));
		expect(parsed).toEqual({ ok: true, command, bytes: bytesOf(JSON.stringify(command)) });
	});

	test.each([
		["binary", Buffer.from('{"cmd":{"type":"call","id":"x"}}')],
		["not JSON", "{"],
		["no cmd", '{"type":"call","id":"x"}'],
		["cmd not an object", '{"cmd":[1]}'],
		["no id", '{"cmd":{"type":"list_sessions"}}'],
		["empty id", '{"cmd":{"type":"list_sessions","id":""}}'],
	])("treats %s as a protocol violation", (_label, data) => {
		const parsed = parseClientMessage(
			data,
			typeof data === "string" ? bytesOf(data) : data.byteLength,
		);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.id).toBeNull();
	});

	test("a command with an id but a bad shape is nacked 400 under its id", () => {
		const text = '{"cmd":{"type":"call","id":"c2"}}';
		expect(parseClientMessage(text, bytesOf(text))).toMatchObject({
			ok: false,
			id: "c2",
			status: 400,
		});
	});

	test("a command over MAX_COMMAND_BYTES is nacked 413; one at the cap is accepted", () => {
		const shell = commandMessage({ type: "call", id: "big", method: "prompt", args: [""] });
		const pad =
			MAX_COMMAND_BYTES -
			bytesOf(JSON.stringify({ type: "call", id: "big", method: "prompt", args: [""] }));
		const atCap = shell.replace('[""]', `["${"x".repeat(pad)}"]`);
		expect(parseClientMessage(atCap, bytesOf(atCap))).toMatchObject({
			ok: true,
			bytes: MAX_COMMAND_BYTES,
		});
		const over = shell.replace('[""]', `["${"x".repeat(pad + 1)}"]`);
		expect(parseClientMessage(over, bytesOf(over))).toMatchObject({
			ok: false,
			id: "big",
			status: 413,
		});
	});
});

describe("close codes", () => {
	test.each(Object.keys(BROWSER_CLOSE) as Array<keyof typeof BROWSER_CLOSE>)(
		"round-trips %s",
		(kind) => {
			const close = browserCloseFor(kind, "detail");
			expect(close.code).toBe(BROWSER_CLOSE[kind]);
			expect(browserCloseFromCode(close.code, close.reason)).toEqual({ kind, message: "detail" });
		},
	);

	test("cuts the reason to 123 bytes without splitting a character", () => {
		const close = browserCloseFor("unauthorized", "é".repeat(200));
		expect(bytesOf(close.reason)).toBeLessThanOrEqual(123);
		expect(close.reason).not.toContain("\uFFFD");
		expect(browserCloseFromCode(close.code, close.reason)?.kind).toBe("unauthorized");
	});

	test.each([1000, 1001, 1006, 4000, 4409])("close %d is not a typed close", (code) => {
		expect(browserCloseFromCode(code, "x")).toBeNull();
	});
});

describe("dial parameters", () => {
	test("round-trip through the socket URL", () => {
		const url = new URL(
			browserSocketUrl("https://fleet.example:8443/app", {
				clientId: "c 1",
				after: 1050,
				proto: OMP_PROTO,
				token: "t&k",
			}),
		);
		expect(url.protocol).toBe("wss:");
		expect(url.pathname).toBe("/ws");
		expect(parseBrowserSocketParams(url.searchParams)).toEqual({
			clientId: "c 1",
			after: 1050,
			proto: OMP_PROTO,
			token: "t&k",
		});
	});

	test("absent or malformed values read as null", () => {
		const url = new URL(
			browserSocketUrl("http://127.0.0.1:1", {
				clientId: null,
				after: null,
				proto: null,
				token: null,
			}),
		);
		expect(url.protocol).toBe("ws:");
		expect(parseBrowserSocketParams(url.searchParams)).toEqual({
			clientId: null,
			after: null,
			proto: null,
			token: null,
		});
		expect(parseBrowserSocketParams(new URLSearchParams("client=&after=-1&proto=5x"))).toEqual({
			clientId: null,
			after: null,
			proto: null,
			token: null,
		});
	});
});

describe("reconnectDelayMs", () => {
	test("ramps from 1 s and caps at 30 s, jittered within the upper half", () => {
		expect(reconnectDelayMs(0, () => 0)).toBe(500);
		expect(reconnectDelayMs(0, () => 1)).toBe(1000);
		expect(reconnectDelayMs(3, () => 1)).toBe(8000);
		expect(reconnectDelayMs(20, () => 1)).toBe(30_000);
		expect(reconnectDelayMs(20, () => 0)).toBe(15_000);
	});
});
