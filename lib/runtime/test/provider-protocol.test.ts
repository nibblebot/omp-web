/**
 * Provider request profile validation (`parseProfile`): per-kind key
 * allowlists, a field owned by another kind is a typed `invalid_request`;
 * and `list-sessions` response parsing.
 */
import { describe, expect, test } from "bun:test";
import {
	ProviderProtocolError,
	parseProviderRequest,
	parseProviderResponse,
	type ProviderRequest,
} from "#lib/runtime/provider-protocol";

function request(profile: Record<string, unknown>): string {
	return JSON.stringify({
		op: "inspect",
		workspaceId: "w1",
		generation: 1,
		workspaceDir: "/w/.checkout",
		homeDir: "/w/.home",
		stateDir: "/w/.state",
		profile,
	});
}

const bwrap = { id: "b", provider: "bwrap", executable: "/p", tools: ["/usr/bin/git"] };
const kube = { id: "k", provider: "kubernetes", executable: "/p", image: "i", namespace: "n" };

function rejection(profile: Record<string, unknown>): ProviderProtocolError {
	try {
		parseProviderRequest(request(profile));
	} catch (err) {
		expect(err).toBeInstanceOf(ProviderProtocolError);
		return err as ProviderProtocolError;
	}
	throw new Error("expected rejection");
}

describe("request profile per kind", () => {
	test("accepts each kind with only its own fields", () => {
		const b: ProviderRequest = parseProviderRequest(request({ ...bwrap, network: "host" }));
		expect(b.profile).toMatchObject({
			provider: "bwrap",
			tools: ["/usr/bin/git"],
			network: "host",
		});
		expect(b.profile).not.toHaveProperty("image");
		const k = parseProviderRequest(request({ ...kube, context: "ctx" }));
		expect(k.profile).toMatchObject({ provider: "kubernetes", image: "i", context: "ctx" });
		expect(k.profile).not.toHaveProperty("tools");
		expect(k.profile).not.toHaveProperty("network");
	});

	test("a k8s field on a bwrap profile is rejected as invalid_request", () => {
		const err = rejection({ ...bwrap, namespace: "n" });
		expect(err.code).toBe("invalid_request");
		expect(err.message).toContain("namespace is a kubernetes field");
		expect(err.message).toContain("not valid on a bwrap profile");
	});

	test("a bwrap field on a kubernetes profile is rejected as invalid_request", () => {
		for (const field of ["tools", "network"]) {
			const err = rejection({ ...kube, [field]: field === "tools" ? [] : "host" });
			expect(err.code).toBe("invalid_request");
			expect(err.message).toContain(`${field} is a bwrap field`);
		}
	});

	test("unknown keys and unknown kinds are still rejected", () => {
		expect(rejection({ ...bwrap, bogus: 1 }).message).toContain("bogus");
		expect(rejection({ ...bwrap, provider: "microvm" }).message).toContain(
			'provider must be "bwrap" or "kubernetes"',
		);
	});

	test("a bwrap profile still requires tools", () => {
		const { tools: _tools, ...noTools } = bwrap;
		expect(rejection(noTools).message).toContain("tools must be an array");
	});
});

const ENVELOPE = { ok: true, handle: "h", observed: "stopped" };
const DIGEST = "a".repeat(64);

describe("list-sessions response", () => {
	test("carries a bounded session inventory and its completeness flag", () => {
		const parsed = parseProviderResponse(
			JSON.stringify({
				...ENVELOPE,
				sessions: [{ path: "s1/s1.jsonl", size: 12, sha256: DIGEST }],
				complete: true,
			}),
		);
		expect(parsed).toMatchObject({
			ok: true,
			sessions: [{ path: "s1/s1.jsonl", size: 12, sha256: DIGEST }],
			complete: true,
		});
	});

	test("an entry without a digest parses (the fleet refuses it, the wire does not)", () => {
		const parsed = parseProviderResponse(
			JSON.stringify({
				...ENVELOPE,
				sessions: [{ path: "s1/s1.jsonl", size: 12 }],
				complete: true,
			}),
		);
		expect(parsed.ok && "sessions" in parsed && parsed.sessions?.[0]).toEqual({
			path: "s1/s1.jsonl",
			size: 12,
		});
	});

	test("an ok response without an inventory carries neither field", () => {
		const parsed = parseProviderResponse(JSON.stringify(ENVELOPE));
		expect(parsed.ok && "sessions" in parsed).toBe(false);
		expect(parsed.ok && "complete" in parsed).toBe(false);
	});

	test.each([
		["a non-array inventory", { sessions: "s1/s1.jsonl" }],
		["a negative size", { sessions: [{ path: "s1/a", size: -1 }] }],
		["a fractional size", { sessions: [{ path: "s1/a", size: 1.5 }] }],
		["an empty path", { sessions: [{ path: "", size: 1 }] }],
		["an unknown entry key", { sessions: [{ path: "s1/a", size: 1, mtime: 3 }] }],
		["a malformed digest", { sessions: [{ path: "s1/a", size: 1, sha256: "x" }] }],
		["an uppercase digest", { sessions: [{ path: "s1/a", size: 1, sha256: "A".repeat(64) }] }],
		["a non-boolean complete flag", { sessions: [], complete: "yes" }],
	])("rejects %s", (_label, extra) => {
		expect(() => parseProviderResponse(JSON.stringify({ ...ENVELOPE, ...extra }))).toThrow(
			/provider response/,
		);
	});
});
