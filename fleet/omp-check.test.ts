/**
 * Unit tests for the first-run omp-stack check (fleet/omp-check.ts).
 *
 * The status-line formatting is pure; the SDK probe is exercised against a
 * sandboxed EMPTY agent dir (deterministic: no providers, no default model,
 * no network — the catalog ships bundled). The configured-provider path is
 * verified live in the PTY offer walk (this machine's real ~/.omp/agent).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { checkOmpSetup, ompStatusLines, resolveOmpBinary } from "./omp-check";

afterAll(cleanupTempDirs);

describe("ompStatusLines", () => {
	test("fully-configured status prints the three facts", () => {
		const lines = ompStatusLines({
			ompInstalled: true,
			providers: ["kimi", "opencode-go"],
			defaultModel: "kimi-code/k3-256k:high",
			error: null,
		});
		expect(lines[0]).toMatch(/^omp: installed /);
		expect(lines[1]).toBe("providers: kimi, opencode-go");
		expect(lines[2]).toBe("default model: kimi-code/k3-256k:high");
		expect(lines).toHaveLength(3);
	});

	test("missing stack prints the omp-standard configuration advice", () => {
		const lines = ompStatusLines({
			ompInstalled: false,
			providers: [],
			defaultModel: null,
			error: null,
		});
		expect(lines[0]).toContain("NOT installed");
		expect(lines[0]).toContain("bun install -g @oh-my-pi/pi-coding-agent");
		expect(lines[1]).toBe("providers: none configured");
		expect(lines[2]).toBe("default model: none");
		expect(lines.some((l) => l.includes("run `omp` and set up a provider + default model"))).toBe(
			true,
		);
		expect(lines.some((l) => l.includes("`omp login`"))).toBe(true);
	});

	test("a probe error is surfaced as a line", () => {
		const lines = ompStatusLines({
			ompInstalled: true,
			providers: [],
			defaultModel: null,
			error: "boom",
		});
		expect(lines.some((l) => l.includes("omp probe error: boom"))).toBe(true);
	});
});

describe("resolveOmpBinary", () => {
	test("resolves to a path when omp is installed (this machine has it)", () => {
		expect(resolveOmpBinary()).toBeTruthy();
	});
});

describe("checkOmpSetup (sandboxed empty agent dir)", () => {
	test("never crashes; settings sandbox holds (no default model)", async () => {
		const dir = tempDir("omp-check");
		const status = await checkOmpSetup(dir);
		expect(status.error).toBeNull();
		expect(Array.isArray(status.providers)).toBe(true);
		// providers CANNOT be asserted empty: the SDK's auth discovery reads the
		// host agent dir's .env regardless of the agentDir override, so a dev
		// machine's keys (e.g. moonshot via ~/.omp/agent/.env) leak into the
		// probe. Settings.loadReadOnly DOES honor the sandbox, so no default
		// model is the deterministic half of this fixture.
		expect(status.defaultModel).toBeNull();
		expect(typeof status.ompInstalled).toBe("boolean");
	});
});
