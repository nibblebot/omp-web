import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { MAX_COMMAND_BYTES } from "#lib/wire/command-limits";
import { MAX_IMAGE_BYTES } from "#lib/wire/image-limits";
import type { ClientCommand } from "#lib/wire/protocol";
import { connect } from "../state";
import { call, sendCommand, setConnected } from "../store/transport";
import {
	FakeWebSocket,
	flushMicrotasks,
	installTransportStubs,
	posted,
	restoreBrowserGlobals,
} from "./web.testkit";

// base64 of MAX_IMAGE_BYTES decoded, as the composer sends it inline.
const FULL_IMAGE_BASE64 = "A".repeat(Math.ceil((MAX_IMAGE_BYTES * 4) / 3));

function callWithPayload(payload: string): ClientCommand {
	return { type: "call", id: "limit-1", method: "getSubagents", args: [payload] };
}

describe("sendCommand size limit", () => {
	beforeEach(() => {
		installTransportStubs();
		connect();
		FakeWebSocket.instances.at(-1)!.onopen?.();
	});
	afterAll(() => restoreBrowserGlobals());

	test("sends a message with two full-size images, the composer's allowed maximum", async () => {
		await sendCommand(callWithPayload(FULL_IMAGE_BASE64 + FULL_IMAGE_BASE64));
		expect(posted).toHaveLength(1);
	});

	test("refuses a command over MAX_COMMAND_BYTES by name, before sending", async () => {
		const oversize = callWithPayload("A".repeat(MAX_COMMAND_BYTES));
		await expect(sendCommand(oversize)).rejects.toThrow("over the 32.0 MiB per-message limit");
		await expect(sendCommand(oversize)).rejects.toThrow("send fewer or smaller images");
		expect(posted).toHaveLength(0);
	});

	test("a server nack 413 surfaces the server's size error", async () => {
		FakeWebSocket.reply = (cmd, ws) =>
			ws.nack(cmd.id, 413, "this request is too large for the server");
		await expect(sendCommand(callWithPayload("small"))).rejects.toThrow(
			"this request is too large for the server",
		);
		expect(posted).toHaveLength(1);
	});

	test("any other nack rejects with the command and its status", async () => {
		FakeWebSocket.reply = (cmd, ws) => ws.nack(cmd.id, 429, "slow down");
		await expect(sendCommand(callWithPayload("small"))).rejects.toThrow(
			'command "call" rejected (HTTP 429)',
		);
	});
});

describe("call() size limit", () => {
	beforeEach(() => {
		installTransportStubs();
		setConnected(true);
	});
	afterAll(() => {
		setConnected(false);
		restoreBrowserGlobals();
	});

	test("rejects an oversize call with the named refusal and sends nothing", async () => {
		const oversize = "A".repeat(MAX_COMMAND_BYTES);
		await expect(call("getSubagents", [oversize], 0)).rejects.toThrow(
			"over the 32.0 MiB per-message limit",
		);
		await flushMicrotasks();
		expect(posted).toHaveLength(0);
	});
});
