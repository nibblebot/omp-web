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
			name: "my-session",
		});
		expect(out).toBe("omp-session --cwd /tmp/repo --port 4721 --name my-session");
	});

	test("leaves unknown keys verbatim", () => {
		expect(fillTemplate("run --thing {nope}", {})).toBe("run --thing {nope}");
		expect(fillTemplate("a {known} b {unknown}", { known: "x" })).toBe("a x b {unknown}");
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

describe("launch line composition", () => {
	test("shell-quoting before substitution keeps metacharacters in argv, not in the shell", () => {
		// host-provider.ts launch does exactly this: every value substituted into
		// the template (cwd/name arrive from HTTP JSON) is shell-quoted
		// first, then the composed line goes to `sh -c`. Probe it against a real
		// shell whose sink prints one argv entry per line: if any value escaped
		// its quotes, the payload would word-split, expand, or execute.
		const cwd = "/srv/repo with spaces/$(touch /tmp/omp-spawn-parse-pwned);rm -rf /";
		const name = "na'me;`id` $HOME && echo $(touch /tmp/pwned)";
		const line = fillTemplate("printf '%s\\n' --cwd {cwd} --name {name}", {
			cwd: shellQuote(cwd),
			name: shellQuote(name),
		});
		const out = Bun.spawnSync(["sh", "-c", line], { stdout: "pipe", stderr: "pipe" });
		expect(out.exitCode, `sh failed: ${out.stderr.toString()}`).toBe(0);
		expect(out.stdout.toString()).toBe(["--cwd", cwd, "--name", name, ""].join("\n"));
	});
});
