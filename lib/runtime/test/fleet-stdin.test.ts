import { describe, expect, test } from "bun:test";
import { buildFleetStdinPayload } from "#lib/runtime/fleet-stdin";

const PAIR = {
	OMP_SESSION_CALLBACK_URL: "https://fleet.example.test/callback",
	OMP_SESSION_CALLBACK_WORKSPACE: "ws-1",
	OMP_SESSION_CALLBACK_GENERATION: "3",
	OMP_SESSION_CALLBACK_TOKEN: "tok-secret",
};

describe("buildFleetStdinPayload", () => {
	test("serializes the exact version-1 callback pair", () => {
		expect(JSON.parse(buildFleetStdinPayload(PAIR))).toEqual({
			v: 1,
			callback: {
				url: "https://fleet.example.test/callback",
				workspace: "ws-1",
				generation: 3,
				token: "tok-secret",
			},
		});
	});

	test("maps ALLOW_HTTP only when the flag is exactly '1'", () => {
		const allowed = JSON.parse(
			buildFleetStdinPayload({ ...PAIR, OMP_SESSION_CALLBACK_ALLOW_HTTP: "1" }),
		) as { callback: Record<string, unknown> };
		expect(allowed.callback.allowHttp).toBe(true);

		const other = JSON.parse(
			buildFleetStdinPayload({ ...PAIR, OMP_SESSION_CALLBACK_ALLOW_HTTP: "true" }),
		) as { callback: Record<string, unknown> };
		expect("allowHttp" in other.callback).toBe(false);
	});

	test("carries a non-empty proxy and omits an empty one", () => {
		const withProxy = JSON.parse(
			buildFleetStdinPayload({ ...PAIR, OMP_SESSION_CALLBACK_PROXY: "http://proxy.test:3128" }),
		) as { callback: Record<string, unknown> };
		expect(withProxy.callback.proxy).toBe("http://proxy.test:3128");

		const emptyProxy = JSON.parse(
			buildFleetStdinPayload({ ...PAIR, OMP_SESSION_CALLBACK_PROXY: "" }),
		) as { callback: Record<string, unknown> };
		expect("proxy" in emptyProxy.callback).toBe(false);
	});

	test("ignores unrelated keys such as OMP_SESSION_RESUME", () => {
		const payload = buildFleetStdinPayload({ ...PAIR, OMP_SESSION_RESUME: "/x/y.jsonl" });
		expect(payload).not.toContain("/x/y.jsonl");
	});

	test("throws when a pair member is missing", () => {
		const { OMP_SESSION_CALLBACK_TOKEN: _token, ...partial } = PAIR;
		expect(() => buildFleetStdinPayload(partial)).toThrow("OMP_SESSION_CALLBACK_TOKEN is required");
	});

	test("throws on a non-integer generation", () => {
		expect(() =>
			buildFleetStdinPayload({ ...PAIR, OMP_SESSION_CALLBACK_GENERATION: "3.5" }),
		).toThrow("non-negative integer");
		expect(() =>
			buildFleetStdinPayload({ ...PAIR, OMP_SESSION_CALLBACK_GENERATION: "-1" }),
		).toThrow("non-negative integer");
	});
});
