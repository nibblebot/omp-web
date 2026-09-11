import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseConfig } from "./config";

/**
 * Behavior coverage for the daemon's own callback admission (parseConfig).
 * The Kubernetes lane's Pod-reachable origin policy lives in
 * shared/callback-url.ts and applies at handoff/preflight; this surface is
 * transport-generic and MUST keep accepting a loopback HTTPS URL, because a
 * host-network bwrap daemon legitimately dials one.
 */

const MANAGED_ENV = [
	"OMP_SESSION_CALLBACK_URL",
	"OMP_SESSION_CALLBACK_ALLOW_HTTP",
	"OMP_SESSION_RESUME",
	"OMP_SESSION_RESUME_REQUIRED",
];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
	for (const name of MANAGED_ENV) {
		savedEnv[name] = process.env[name];
		delete process.env[name];
	}
});

afterAll(() => {
	for (const name of MANAGED_ENV) {
		if (savedEnv[name] === undefined) delete process.env[name];
		else process.env[name] = savedEnv[name];
	}
});

describe("parseConfig callback URL", () => {
	test("accepts generic HTTPS including a loopback host", () => {
		const loopback = parseConfig([
			"--callback-url",
			"https://127.0.0.1:9443",
			"--callback-workspace",
			"w",
		]);
		expect(loopback.callbackUrl).toBe("https://127.0.0.1:9443/");
		const named = parseConfig([
			"--callback-url",
			"https://fleet.example.com",
			"--callback-workspace",
			"w",
		]);
		expect(named.callbackUrl).toBe("https://fleet.example.com/");
		expect(named.callbackGeneration).toBe(1);
	});

	test("rejects URL credentials and non-root paths generically", () => {
		expect(() =>
			parseConfig(["--callback-url", "https://u:p@fleet.example.com", "--callback-workspace", "w"]),
		).toThrow(/credentials/);
		expect(() =>
			parseConfig([
				"--callback-url",
				"https://fleet.example.com/base",
				"--callback-workspace",
				"w",
			]),
		).toThrow(/path/);
		expect(() =>
			parseConfig([
				"--callback-url",
				"https://fleet.example.com/?q=1",
				"--callback-workspace",
				"w",
			]),
		).toThrow(/query string or fragment/);
	});

	test("opens HTTP only for an explicit loopback exception", () => {
		expect(() =>
			parseConfig(["--callback-url", "http://127.0.0.1:9443", "--callback-workspace", "w"]),
		).toThrow(/https required/);
		const allowed = parseConfig([
			"--callback-url",
			"http://127.0.0.1:9443",
			"--callback-allow-http",
			"--callback-workspace",
			"w",
		]);
		expect(allowed.callbackUrl).toBe("http://127.0.0.1:9443/");
		expect(allowed.callbackAllowHttp).toBe(true);
		expect(() =>
			parseConfig([
				"--callback-url",
				"http://fleet.example.com",
				"--callback-allow-http",
				"--callback-workspace",
				"w",
			]),
		).toThrow(/only honors loopback hosts/);
	});
});

describe("parseConfig required resume", () => {
	test("refuses to arm required resume without a target", () => {
		expect(() => parseConfig(["--resume-required"])).toThrow(/needs a resume target/);
	});

	test("arms only for a bare flag or a truthy value", () => {
		expect(parseConfig(["--resume", "/tmp/x.jsonl"]).resumeRequired).toBe(false);
		expect(parseConfig(["--resume-required", "--resume", "/tmp/x.jsonl"]).resumeRequired).toBe(
			true,
		);
		expect(parseConfig(["--resume-required=1", "--resume", "/tmp/x.jsonl"]).resumeRequired).toBe(
			true,
		);
		expect(
			parseConfig(["--resume-required=false", "--resume", "/tmp/x.jsonl"]).resumeRequired,
		).toBe(false);
	});
});
