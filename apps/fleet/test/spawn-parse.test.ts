/**
 * Hermetic unit tests for fleet/spawn-parse.ts: template fill and shell quoting.
 */

import { describe, expect, test } from "bun:test";

import { fillTemplate, shellQuote } from "../spawn-parse";

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

	test("is pure text substitution, no shell escaping by design (callers must shell-quote)", () => {
		const out = fillTemplate("omp-session --cwd {cwd} --token {token}", {
			cwd: "/path with spaces",
			token: "s3cr&t;$(touch /tmp/x)",
		});
		// fillTemplate is deliberately escaping-free; the supervisor shell-quotes
		// every value BEFORE substitution (shellQuote) so nothing like this can
		// reach `sh -c`.
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

describe("shellQuote", () => {
	test("wraps plain values in single quotes", () => {
		expect(shellQuote("plain")).toBe("'plain'");
		expect(shellQuote("")).toBe("''");
		expect(shellQuote("/srv/repos/acme")).toBe("'/srv/repos/acme'");
	});

	test("escapes embedded single quotes as '\\''", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		expect(shellQuote("a'b'c")).toBe("'a'\\''b'\\''c'");
		expect(shellQuote("'")).toBe("''\\'''");
	});

	test("spaces, $(), backticks, and newlines stay literal inside the quotes", () => {
		expect(shellQuote("/path with spaces")).toBe("'/path with spaces'");
		expect(shellQuote("k=$(touch /tmp/pwned)")).toBe("'k=$(touch /tmp/pwned)'");
		expect(shellQuote("`id`")).toBe("'`id`'");
		expect(shellQuote("$HOME;rm -rf /")).toBe("'$HOME;rm -rf /'");
		expect(shellQuote("line1\nline2")).toBe("'line1\nline2'");
	});
});
