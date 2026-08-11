/**
 * Hermetic unit tests for fleet/spawn-parse.ts: template fill,
 * `OMP_SESSION|` line parsing against interleaved noise, and the R6b endpoint
 * precedence matrix. No live daemons.
 */

import { describe, expect, test } from "bun:test";

import { fillTemplate, parseContractLine, resolveEndpoint } from "./spawn-parse";
import type { StdoutContractLine } from "../src/protocol";

// ---------------------------------------------------------------------------
// fillTemplate
// ---------------------------------------------------------------------------

describe("fillTemplate", () => {
	test("substitutes {key} placeholders", () => {
		const out = fillTemplate("omp-session --cwd {cwd} --port {port} --name {name}", {
			cwd: "/tmp/repo",
			port: "4721",
			name: "my-daemon",
		});
		expect(out).toBe("omp-session --cwd /tmp/repo --port 4721 --name my-daemon");
	});

	test("leaves unknown keys verbatim", () => {
		expect(fillTemplate("run --thing {nope}", {})).toBe("run --thing {nope}");
		expect(fillTemplate("a {known} b {unknown}", { known: "x" })).toBe("a x b {unknown}");
	});

	test("expands {labels} to empty string when there are none", () => {
		const out = fillTemplate("omp-session {labels} --name n", { labels: "" });
		expect(out).toBe("omp-session  --name n");
	});

	test("expands {labels} to repeated --label args when present", () => {
		const out = fillTemplate("omp-session {labels} --name n", {
			labels: "--label team=web --label tier=prod",
		});
		expect(out).toBe("omp-session --label team=web --label tier=prod --name n");
	});

	test("does no shell escaping — values with spaces/quotes insert raw", () => {
		const out = fillTemplate("omp-session --cwd {cwd} --token {token}", {
			cwd: "/path with spaces",
			token: "s3cr&t;$(touch /tmp/x)",
		});
		expect(out).toBe("omp-session --cwd /path with spaces --token s3cr&t;$(touch /tmp/x)");
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
// parseContractLine
// ---------------------------------------------------------------------------

describe("parseContractLine", () => {
	test("parses a listening line", () => {
		const line = 'OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}';
		expect(parseContractLine(line)).toEqual({
			event: "listening",
			bind: "127.0.0.1",
			port: 4721,
			url: "ws://127.0.0.1:4721",
		});
	});

	test("parses a listening line with advertise", () => {
		const line =
			'OMP_SESSION|{"event":"listening","bind":"0.0.0.0","port":4721,"url":"ws://0.0.0.0:4721","advertise":"ws://omp.example.com:4721"}';
		expect(parseContractLine(line)).toEqual({
			event: "listening",
			bind: "0.0.0.0",
			port: 4721,
			url: "ws://0.0.0.0:4721",
			advertise: "ws://omp.example.com:4721",
		});
	});

	test("parses an endpoint line", () => {
		expect(parseContractLine('OMP_SESSION|{"event":"endpoint","url":"ws://10.0.0.5:9000"}')).toEqual({
			event: "endpoint",
			url: "ws://10.0.0.5:9000",
		});
	});

	test("ignores extra fields", () => {
		const line = 'OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":1,"url":"ws://x","extra":true}';
		expect(parseContractLine(line)).toEqual({ event: "listening", bind: "127.0.0.1", port: 1, url: "ws://x" });
	});

	test("non-prefixed lines (human logs) are null", () => {
		expect(parseContractLine("omp-session listening on ws://127.0.0.1:4721")).toBeNull();
		expect(parseContractLine("OMP_SESSION listening…")).toBeNull();
		expect(parseContractLine("")).toBeNull();
		expect(parseContractLine("OMP_SESSION|")).toBeNull();
		expect(parseContractLine("OMP_SESSION")).toBeNull();
	});

	test("interleaved noise between valid lines is ignored", () => {
		const noise = [
			"resolving provider…",
			'OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://127.0.0.1:4721"}',
			"some random stderr-style text",
			'OMP_SESSION|{"event":"endpoint","url":"ws://10.0.0.5:9000"}',
			"",
		];
		expect(noise.map(parseContractLine)).toEqual([
			null,
			{ event: "listening", bind: "127.0.0.1", port: 4721, url: "ws://127.0.0.1:4721" },
			null,
			{ event: "endpoint", url: "ws://10.0.0.5:9000" },
			null,
		]);
	});

	test("malformed JSON is null, never throws", () => {
		expect(parseContractLine("OMP_SESSION|{not json")).toBeNull();
		expect(parseContractLine("OMP_SESSION|{\"event\":\"listening\"")).toBeNull();
		expect(parseContractLine("OMP_SESSION|")).toBeNull();
		expect(parseContractLine("OMP_SESSION|   ")).toBeNull();
	});

	test("valid JSON with wrong shapes is null", () => {
		// not an object
		expect(parseContractLine("OMP_SESSION|[1,2,3]")).toBeNull();
		expect(parseContractLine('OMP_SESSION|"listening"')).toBeNull();
		expect(parseContractLine("OMP_SESSION|42")).toBeNull();
		expect(parseContractLine("OMP_SESSION|null")).toBeNull();
		// unknown event
		expect(parseContractLine('OMP_SESSION|{"event":"bogus"}')).toBeNull();
		expect(parseContractLine('OMP_SESSION|{"event":42}')).toBeNull();
		expect(parseContractLine("OMP_SESSION|{}")).toBeNull();
		// listening missing/typo'd required fields
		expect(parseContractLine('OMP_SESSION|{"event":"listening","port":4721,"url":"ws://x"}')).toBeNull(); // no bind
		expect(parseContractLine('OMP_SESSION|{"event":"listening","bind":"127.0.0.1","url":"ws://x"}')).toBeNull(); // no port
		expect(parseContractLine('OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721}')).toBeNull(); // no url
		expect(parseContractLine('OMP_SESSION|{"event":"listening","bind":42,"port":4721,"url":"ws://x"}')).toBeNull(); // bind not string
		expect(parseContractLine('OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":"4721","url":"ws://x"}')).toBeNull(); // port not number
		expect(parseContractLine('OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":5}')).toBeNull(); // url not string
		expect(
			parseContractLine('OMP_SESSION|{"event":"listening","bind":"127.0.0.1","port":4721,"url":"ws://x","advertise":5}')
		).toBeNull(); // advertise present but not string
		// endpoint wrong shape
		expect(parseContractLine('OMP_SESSION|{"event":"endpoint"}')).toBeNull();
		expect(parseContractLine('OMP_SESSION|{"event":"endpoint","url":true}')).toBeNull();
	});

	test("never throws on any input", () => {
		const inputs = [
			null as unknown as string,
			undefined as unknown as string,
			42 as unknown as string,
			{} as unknown as string,
			"OMP_SESSION|{",
			"OMP_SESSION|\u0000",
			"OMP_SESSION|{" + '"a":'.repeat(1000) + "}",
		];
		for (const input of inputs) {
			expect(() => parseContractLine(input)).not.toThrow();
		}
	});
});

// ---------------------------------------------------------------------------
// resolveEndpoint
// ---------------------------------------------------------------------------

const listening = (port: number, advertise?: string): StdoutContractLine => ({
	event: "listening",
	bind: "127.0.0.1",
	port,
	url: `ws://127.0.0.1:${port}`,
	...(advertise !== undefined ? { advertise } : {}),
});

const endpoint = (url: string): StdoutContractLine => ({ event: "endpoint", url });

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
