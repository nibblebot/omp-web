/**
 * Hermetic unit tests for orchestrator/spawn-parse.ts: template fill,
 * `OMPD|` line parsing against interleaved noise, and the R6b endpoint
 * precedence matrix. No live daemons.
 */

import { describe, expect, test } from "bun:test";

import { fillTemplate, parseOmpdLine, resolveEndpoint } from "./spawn-parse";
import type { OmpdStdoutLine } from "../src/protocol";

// ---------------------------------------------------------------------------
// fillTemplate
// ---------------------------------------------------------------------------

describe("fillTemplate", () => {
	test("substitutes {key} placeholders", () => {
		const out = fillTemplate("ompd --cwd {cwd} --port {port} --name {name}", {
			cwd: "/tmp/repo",
			port: "4721",
			name: "my-daemon",
		});
		expect(out).toBe("ompd --cwd /tmp/repo --port 4721 --name my-daemon");
	});

	test("leaves unknown keys verbatim", () => {
		expect(fillTemplate("run --thing {nope}", {})).toBe("run --thing {nope}");
		expect(fillTemplate("a {known} b {unknown}", { known: "x" })).toBe("a x b {unknown}");
	});

	test("expands {labels} to empty string when there are none", () => {
		const out = fillTemplate("ompd {labels} --name n", { labels: "" });
		expect(out).toBe("ompd  --name n");
	});

	test("expands {labels} to repeated --label args when present", () => {
		const out = fillTemplate("ompd {labels} --name n", {
			labels: "--label team=web --label tier=prod",
		});
		expect(out).toBe("ompd --label team=web --label tier=prod --name n");
	});

	test("does no shell escaping — values with spaces/quotes insert raw", () => {
		const out = fillTemplate("ompd --cwd {cwd} --token {token}", {
			cwd: "/path with spaces",
			token: "s3cr&t;$(touch /tmp/x)",
		});
		expect(out).toBe("ompd --cwd /path with spaces --token s3cr&t;$(touch /tmp/x)");
	});

	test("replaces every occurrence of the same key", () => {
		expect(fillTemplate("{k}-{k}", { k: "v" })).toBe("v-v");
	});

	test("empty template and empty vars", () => {
		expect(fillTemplate("", {})).toBe("");
		expect(fillTemplate("{a}", { a: "" })).toBe("");
	});
});

// ---------------------------------------------------------------------------
// parseOmpdLine
// ---------------------------------------------------------------------------

describe("parseOmpdLine", () => {
	test("parses a listening line", () => {
		const line = 'OMPD|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}';
		expect(parseOmpdLine(line)).toEqual({
			event: "listening",
			bind: "127.0.0.1",
			port: 4721,
			url: "ws://127.0.0.1:4721",
		});
	});

	test("parses a listening line with advertise", () => {
		const line =
			'OMPD|{"event":"listening","bind":"0.0.0.0","port":4721,"url":"ws://0.0.0.0:4721","advertise":"ws://omp.example.com:4721"}';
		expect(parseOmpdLine(line)).toEqual({
			event: "listening",
			bind: "0.0.0.0",
			port: 4721,
			url: "ws://0.0.0.0:4721",
			advertise: "ws://omp.example.com:4721",
		});
	});

	test("parses an endpoint line", () => {
		expect(parseOmpdLine('OMPD|{"event":"endpoint","url":"ws://10.0.0.5:9000"}')).toEqual({
			event: "endpoint",
			url: "ws://10.0.0.5:9000",
		});
	});

	test("ignores extra fields", () => {
		const line = 'OMPD|{"event":"listening","bind":"127.0.0.1","port":1,"url":"ws://x","extra":true}';
		expect(parseOmpdLine(line)).toEqual({ event: "listening", bind: "127.0.0.1", port: 1, url: "ws://x" });
	});

	test("non-prefixed lines (human logs) are null", () => {
		expect(parseOmpdLine("ompd listening on ws://127.0.0.1:4721")).toBeNull();
		expect(parseOmpdLine("OMPD listening…")).toBeNull();
		expect(parseOmpdLine("")).toBeNull();
		expect(parseOmpdLine("OMPD|")).toBeNull();
		expect(parseOmpdLine("OMPD")).toBeNull();
	});

	test("interleaved noise between valid lines is ignored", () => {
		const noise = [
			"resolving provider…",
			'OMPD|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}',
			"some random stderr-style text",
			'OMPD|{"event":"endpoint","url":"ws://10.0.0.5:9000"}',
			"",
		];
		expect(noise.map(parseOmpdLine)).toEqual([
			null,
			{ event: "listening", bind: "127.0.0.1", port: 4721, url: "ws://127.0.0.1:4721" },
			null,
			{ event: "endpoint", url: "ws://10.0.0.5:9000" },
			null,
		]);
	});

	test("malformed JSON is null, never throws", () => {
		expect(parseOmpdLine("OMPD|{not json")).toBeNull();
		expect(parseOmpdLine("OMPD|{\"event\":\"listening\"")).toBeNull();
		expect(parseOmpdLine("OMPD|")).toBeNull();
		expect(parseOmpdLine("OMPD|   ")).toBeNull();
	});

	test("valid JSON with wrong shapes is null", () => {
		// not an object
		expect(parseOmpdLine("OMPD|[1,2,3]")).toBeNull();
		expect(parseOmpdLine('OMPD|"listening"')).toBeNull();
		expect(parseOmpdLine("OMPD|42")).toBeNull();
		expect(parseOmpdLine("OMPD|null")).toBeNull();
		// unknown event
		expect(parseOmpdLine('OMPD|{"event":"bogus"}')).toBeNull();
		expect(parseOmpdLine('OMPD|{"event":42}')).toBeNull();
		expect(parseOmpdLine("OMPD|{}")).toBeNull();
		// listening missing/typo'd required fields
		expect(parseOmpdLine('OMPD|{"event":"listening","port":4721,"url":"ws://x"}')).toBeNull(); // no bind
		expect(parseOmpdLine('OMPD|{"event":"listening","bind":"127.0.0.1","url":"ws://x"}')).toBeNull(); // no port
		expect(parseOmpdLine('OMPD|{"event":"listening","bind":"127.0.0.1","port":4721}')).toBeNull(); // no url
		expect(parseOmpdLine('OMPD|{"event":"listening","bind":42,"port":4721,"url":"ws://x"}')).toBeNull(); // bind not string
		expect(parseOmpdLine('OMPD|{"event":"listening","bind":"127.0.0.1","port":"4721","url":"ws://x"}')).toBeNull(); // port not number
		expect(parseOmpdLine('OMPD|{"event":"listening","bind":"127.0.0.1","port":4721,"url":5}')).toBeNull(); // url not string
		expect(
			parseOmpdLine('OMPD|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://x","advertise":5}')
		).toBeNull(); // advertise present but not string
		// endpoint wrong shape
		expect(parseOmpdLine('OMPD|{"event":"endpoint"}')).toBeNull();
		expect(parseOmpdLine('OMPD|{"event":"endpoint","url":true}')).toBeNull();
	});

	test("never throws on any input", () => {
		const inputs = [
			null as unknown as string,
			undefined as unknown as string,
			42 as unknown as string,
			{} as unknown as string,
			"OMPD|{",
			"OMPD|\u0000",
			"OMPD|{" + '"a":'.repeat(1000) + "}",
		];
		for (const input of inputs) {
			expect(() => parseOmpdLine(input)).not.toThrow();
		}
	});
});

// ---------------------------------------------------------------------------
// resolveEndpoint
// ---------------------------------------------------------------------------

const listening = (port: number, advertise?: string): OmpdStdoutLine => ({
	event: "listening",
	bind: "127.0.0.1",
	port,
	url: `ws://127.0.0.1:${port}`,
	...(advertise !== undefined ? { advertise } : {}),
});

const endpoint = (url: string): OmpdStdoutLine => ({ event: "endpoint", url });

describe("resolveEndpoint precedence", () => {
	test("null with no lines", () => {
		expect(resolveEndpoint([])).toBeNull();
		expect(resolveEndpoint([], "template.example")).toBeNull();
	});

	test("null until a listening line is seen — endpoint-only output doesn't count", () => {
		expect(resolveEndpoint([endpoint("ws://10.0.0.5:9000")])).toBeNull();
		expect(resolveEndpoint([endpoint("ws://10.0.0.5:9000")], "template.example")).toBeNull();
	});

	test("loopback tier: listening line alone → ws://127.0.0.1:<port>", () => {
		expect(resolveEndpoint([listening(4721)])).toEqual({ url: "ws://127.0.0.1:4721", source: "loopback" });
	});

	test("advertise tier beats loopback", () => {
		expect(resolveEndpoint([listening(4721, "ws://omp.example.com:4721")])).toEqual({
			url: "ws://omp.example.com:4721",
			source: "advertise",
		});
	});

	test("template tier beats advertise", () => {
		expect(resolveEndpoint([listening(4721, "ws://omp.example.com:4721")], "relay.local")).toEqual({
			url: "ws://relay.local:4721",
			source: "template",
		});
	});

	test("template tier beats loopback when no advertise", () => {
		expect(resolveEndpoint([listening(4721)], "relay.local")).toEqual({
			url: "ws://relay.local:4721",
			source: "template",
		});
	});

	test("wrapper tier beats template", () => {
		expect(resolveEndpoint([listening(4721), endpoint("ws://10.0.0.5:9000")], "relay.local")).toEqual({
			url: "ws://10.0.0.5:9000",
			source: "wrapper",
		});
	});

	test("wrapper tier beats advertise and loopback without templateHost", () => {
		expect(resolveEndpoint([listening(4721, "ws://omp.example.com:4721"), endpoint("ws://10.0.0.5:9000")])).toEqual({
			url: "ws://10.0.0.5:9000",
			source: "wrapper",
		});
	});

	test("wrapper: LAST endpoint line wins", () => {
		expect(
			resolveEndpoint([listening(4721), endpoint("ws://10.0.0.5:9000"), endpoint("ws://10.0.0.9:9001")])
		).toEqual({ url: "ws://10.0.0.9:9001", source: "wrapper" });
	});

	test("listening: LAST listening line's port is used", () => {
		expect(resolveEndpoint([listening(4721), listening(4722)])).toEqual({
			url: "ws://127.0.0.1:4722",
			source: "loopback",
		});
		expect(resolveEndpoint([listening(4721), listening(4722, "ws://a.example")], "relay.local")).toEqual({
			url: "ws://relay.local:4722",
			source: "template",
		});
	});

	test("noise lines interleaved do not disturb resolution", () => {
		expect(
			resolveEndpoint(
				[
					{ event: "endpoint", url: "ws://early.example:1" },
					listening(4721),
					{ event: "endpoint", url: "ws://late.example:2" },
					listening(4722, "ws://adv.example:3"),
				],
				"template.example"
			)
		).toEqual({ url: "ws://late.example:2", source: "wrapper" });
	});

	test("empty templateHost string is treated as absent", () => {
		expect(resolveEndpoint([listening(4721)], "")).toEqual({ url: "ws://127.0.0.1:4721", source: "loopback" });
	});
});
