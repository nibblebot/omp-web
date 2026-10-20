/**
 * The provider `preflight` op wire contract: the `{ok:true, checks}` response
 * envelope, the placeholder request the fleet builds, and runProviderOp's
 * op/response-shape pairing, against throwaway shell-script providers.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { ProviderOpError, runProviderOp } from "../provider-exec";
import {
	PROVIDER_OPS,
	ProviderProtocolError,
	buildPreflightRequest,
	parseProviderResponse,
	validateProviderRequest,
	type ProviderProfile,
	type ProviderRequest,
} from "../provider-protocol";

afterAll(cleanupTempDirs);

const profile: ProviderProfile = {
	id: "p",
	provider: "kubernetes",
	executable: "/unused",
};

/** A provider script that records argv[1] + stdin next to itself, then prints `stdout`. */
function scriptProvider(stdout: string): {
	exe: string;
	seen: () => { op: string; stdin: string };
} {
	const dir = tempDir("provider-preflight-");
	const exe = join(dir, "provider.sh");
	writeFileSync(
		exe,
		`#!/bin/sh\nprintf '%s' "$1" > "$0.op"\ncat > "$0.stdin"\nprintf '%s\\n' '${stdout}'\n`,
	);
	chmodSync(exe, 0o755);
	return {
		exe,
		seen: () => ({
			op: readFileSync(`${exe}.op`, "utf8"),
			stdin: readFileSync(`${exe}.stdin`, "utf8"),
		}),
	};
}

const CHECKS = [
	{ name: "kube-api", ok: true, detail: "reachable" },
	{ name: "kube-namespace", ok: false, detail: "missing", remediation: "create it" },
];

describe("preflight response envelope", () => {
	test("op list carries preflight", () => {
		expect(PROVIDER_OPS).toContain("preflight");
	});

	test("parses {ok:true, checks} and keeps remediation optional", () => {
		const parsed = parseProviderResponse(JSON.stringify({ ok: true, checks: CHECKS }));
		expect(parsed).toEqual({ ok: true, checks: CHECKS });
	});

	test("rejects lifecycle fields mixed into a preflight envelope", () => {
		expect(() =>
			parseProviderResponse(
				JSON.stringify({ ok: true, checks: CHECKS, handle: "h", observed: "running" }),
			),
		).toThrow(ProviderProtocolError);
	});

	test("rejects malformed checks", () => {
		const bad = (checks: unknown) => () =>
			parseProviderResponse(JSON.stringify({ ok: true, checks }));
		expect(bad("nope")).toThrow(ProviderProtocolError);
		expect(bad([{ name: "x", ok: "yes", detail: "d" }])).toThrow(ProviderProtocolError);
		expect(bad([{ name: "", ok: true, detail: "d" }])).toThrow(ProviderProtocolError);
		expect(bad([{ name: "x", ok: true, detail: "d", extra: 1 }])).toThrow(ProviderProtocolError);
		expect(bad([{ name: "x", ok: false, detail: "d", remediation: "" }])).toThrow(
			ProviderProtocolError,
		);
	});

	test("a lifecycle ok envelope still parses as before", () => {
		expect(
			parseProviderResponse(JSON.stringify({ ok: true, handle: "h", observed: "stopped" })),
		).toMatchObject({ ok: true, handle: "h", observed: "stopped" });
	});
});

describe("preflight request", () => {
	test("the fleet's placeholder request validates and carries the workspace root", () => {
		const request = buildPreflightRequest(profile, "/data/clones");
		expect(validateProviderRequest(request)).toMatchObject({
			op: "preflight",
			workspaceId: "preflight",
			generation: 1,
			workspaceDir: "/data/clones",
			profile: { id: "p" },
		});
	});
});

describe("runProviderOp preflight", () => {
	test("invokes `<exe> preflight` with the placeholder request and returns the checks", async () => {
		const provider = scriptProvider(JSON.stringify({ ok: true, checks: CHECKS }));
		const response = await runProviderOp(
			provider.exe,
			buildPreflightRequest(profile, "/data/clones"),
		);
		expect(response).toEqual({ ok: true, checks: CHECKS });
		const seen = provider.seen();
		expect(seen.op).toBe("preflight");
		expect(JSON.parse(seen.stdin)).toMatchObject({
			op: "preflight",
			workspaceDir: "/data/clones",
		});
	});

	test("an older provider rejecting the op returns its invalid_request envelope", async () => {
		const provider = scriptProvider(
			JSON.stringify({
				ok: false,
				error: { code: "invalid_request", message: "op must be one of x", retryable: false },
			}),
		);
		const response = await runProviderOp(provider.exe, buildPreflightRequest(profile, "/r"));
		expect(response.ok).toBe(false);
		if (!response.ok) expect(response.error.code).toBe("invalid_request");
	});

	test("a lifecycle response to preflight is an internal error", async () => {
		const provider = scriptProvider(JSON.stringify({ ok: true, handle: "h", observed: "missing" }));
		const run = runProviderOp(provider.exe, buildPreflightRequest(profile, "/r"));
		await expect(run).rejects.toBeInstanceOf(ProviderOpError);
		await expect(run).rejects.toMatchObject({ code: "internal" });
	});

	test("a preflight response to a lifecycle op is an internal error", async () => {
		const provider = scriptProvider(JSON.stringify({ ok: true, checks: CHECKS }));
		const request: ProviderRequest & { op: "inspect" } = {
			...buildPreflightRequest(profile, "/r"),
			op: "inspect",
		};
		await expect(runProviderOp(provider.exe, request)).rejects.toMatchObject({ code: "internal" });
	});
});
