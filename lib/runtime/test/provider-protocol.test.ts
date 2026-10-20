/**
 * Provider request profile validation (`parseProfile`): per-kind key
 * allowlists, a field owned by another kind is a typed `invalid_request`.
 */
import { describe, expect, test } from "bun:test";
import {
	ProviderProtocolError,
	parseProviderRequest,
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
