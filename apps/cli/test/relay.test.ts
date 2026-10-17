import { describe, expect, test } from "bun:test";
import { generateRoomId } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { parseRelayArgs, startRelayServer } from "../relay";

describe("parseRelayArgs", () => {
	test("--port is required and bounded", () => {
		expect(parseRelayArgs([])).toEqual({ error: "--port is required" });
		expect(parseRelayArgs(["--port", "65536"])).toEqual({ error: "--port must be at most 65535" });
		expect(parseRelayArgs(["--port", "abc"])).toEqual({ error: "--port must be an integer >= 0" });
		expect(parseRelayArgs(["--port", "4731"])).toEqual({ port: 4731, hostname: "127.0.0.1" });
	});

	test("optional flags are validated and passed through", () => {
		expect(
			parseRelayArgs([
				"--port",
				"4731",
				"--hostname",
				"0.0.0.0",
				"--max-guests",
				"8",
				"--max-rooms",
				"2",
			]),
		).toEqual({ port: 4731, hostname: "0.0.0.0", maxGuests: 8, maxRooms: 2 });
		expect(parseRelayArgs(["--port", "4731", "--max-guests", "0"])).toEqual({
			error: "--max-guests must be an integer >= 1",
		});
	});

	test("unknown options and stray arguments are rejected", () => {
		expect(parseRelayArgs(["--port", "4731", "--token", "x"])).toEqual({
			error: "unknown option: --token",
		});
		expect(parseRelayArgs(["4731"])).toEqual({ error: "unexpected argument: 4731" });
		expect(parseRelayArgs(["--port"])).toEqual({ error: "--port needs a value" });
	});
});

describe("startRelayServer", () => {
	test("serves /r/<room> upgrades on an ephemeral port and reports its ws:// URL", async () => {
		// Not stopped: stopping a server with open close-coded sockets hangs in
		// Bun (see AGENTS.md), and the process exits when the test run ends.
		const running = startRelayServer({ port: 0 });
		expect(running.url).toBe(`ws://127.0.0.1:${running.server.port}`);

		const ws = new WebSocket(`${running.url}/r/${generateRoomId()}?role=guest`);
		ws.binaryType = "arraybuffer";
		const closed = Promise.withResolvers<CloseEvent>();
		ws.onclose = (ev) => closed.resolve(ev);
		const ev = await closed.promise;
		expect(ev.code).toBe(4004);
	});

	test("paths outside /r/ get a plain 404", async () => {
		const running = startRelayServer({ port: 0 });
		const res = await fetch(`http://127.0.0.1:${running.server.port}/events`);
		expect(res.status).toBe(404);
	});
});
