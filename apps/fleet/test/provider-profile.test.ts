/**
 * Provider profile config validation: a discriminated union per kind. A field
 * owned by another kind is a typed validation error, never silently carried.
 */
import { describe, expect, test } from "bun:test";
import { PROVIDER_CAPABILITIES, PROVIDER_KINDS } from "#lib/runtime/provider-protocol";
import { toPublicProfile, validateProfiles } from "../provider-profile";

const bwrap = {
	provider: "bwrap",
	executable: "/usr/bin/provider",
	tools: ["/usr/bin/git"] as string[],
} as const;
const kube = {
	provider: "kubernetes",
	executable: "/usr/bin/provider",
	image: "img",
	namespace: "ns",
	context: "ctx",
} as const;

describe("validateProfiles per kind", () => {
	test("a valid profile of each kind loads with only its own fields", () => {
		const { profiles, errors } = validateProfiles({
			b: { ...bwrap, network: "host" },
			k: { ...kube, storage: { class: "fast" } },
		});
		expect(errors).toEqual([]);
		expect(profiles.b).toEqual({ id: "b", ...bwrap, network: "host" });
		expect(profiles.k).toEqual({ id: "k", ...kube, storage: { class: "fast" } });
		expect(profiles.k).not.toHaveProperty("tools");
		expect(profiles.b).not.toHaveProperty("image");
	});

	test("kubernetes profiles need no tools; bwrap profiles still require them", () => {
		const { profiles, errors } = validateProfiles({
			k: kube,
			b: { provider: "bwrap", executable: "/usr/bin/provider" },
		});
		expect(Object.keys(profiles)).toEqual(["k"]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ code: "invalid_request", profileId: "b" });
		expect(errors[0]!.message).toContain("tools is required");
	});

	test.each(["image", "namespace", "context"])(
		"k8s field %s on a bwrap profile is a typed error and the profile is dropped",
		(field) => {
			const { profiles, errors } = validateProfiles({ b: { ...bwrap, [field]: "x" } });
			expect(profiles).toEqual({});
			expect(errors).toEqual([
				{
					code: "invalid_request",
					profileId: "b",
					message: `${field} is a kubernetes field and is not valid on a bwrap profile`,
				},
			]);
		},
	);

	test.each(["tools", "network"])(
		"bwrap field %s on a kubernetes profile is a typed error and the profile is dropped",
		(field) => {
			const { profiles, errors } = validateProfiles({
				k: { ...kube, [field]: field === "tools" ? [] : "host" },
			});
			expect(profiles).toEqual({});
			expect(errors).toEqual([
				{
					code: "invalid_request",
					profileId: "k",
					message: `${field} is a bwrap field and is not valid on a kubernetes profile`,
				},
			]);
		},
	);

	test("an unknown provider names the kinds list", () => {
		const { errors } = validateProfiles({ x: { ...bwrap, provider: "microvm" } });
		expect(errors[0]!.message).toBe(
			`provider must be "bwrap", "kubernetes" or "host", got "microvm"`,
		);
	});
});

describe("host profiles", () => {
	test("a host profile needs no executable and carries only id, provider and secretRefs", () => {
		const { profiles, errors } = validateProfiles({
			h: { provider: "host", secretRefs: { KEY: "env:MODEL_KEY" } },
			bare: { provider: "host" },
		});
		expect(errors).toEqual([]);
		expect(profiles.h).toEqual({ id: "h", provider: "host", secretRefs: { KEY: "env:MODEL_KEY" } });
		expect(profiles.bare).toEqual({ id: "bare", provider: "host" });
		expect(profiles.bare).not.toHaveProperty("executable");
	});

	test.each([
		["executable", "/usr/bin/provider"],
		["resources", { cpu: "1" }],
		["storage", { class: "fast" }],
	])("%s on a host profile is a typed error and the profile is dropped", (field, value) => {
		const { profiles, errors } = validateProfiles({ h: { provider: "host", [field]: value } });
		expect(profiles).toEqual({});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ code: "invalid_request", profileId: "h" });
		expect(errors[0]!.message).toContain(`${field} is not valid on a host profile`);
	});

	test.each([
		["tools", [], "bwrap"],
		["network", "host", "bwrap"],
		["image", "img", "kubernetes"],
	])("%s on a host profile names its owner kind", (field, value, owner) => {
		const { profiles, errors } = validateProfiles({ h: { provider: "host", [field]: value } });
		expect(profiles).toEqual({});
		expect(errors[0]!.message).toBe(
			`${field} is a ${owner} field and is not valid on a host profile`,
		);
	});

	test("every executable kind still requires an executable", () => {
		const { profiles, errors } = validateProfiles({
			b: { provider: "bwrap", tools: [] },
			k: { provider: "kubernetes" },
		});
		expect(profiles).toEqual({});
		expect(errors.map((e) => e.message)).toEqual([
			expect.stringContaining("executable is required"),
			expect.stringContaining("executable is required"),
		]);
	});
});

describe("toPublicProfile", () => {
	test("is secret-free and carries network only for bwrap", () => {
		const { profiles } = validateProfiles({
			b: { ...bwrap, network: "host", secretRefs: { KEY: "env:SECRET_VALUE_NAME" } },
			k: { ...kube, secretRefs: { KEY: "secret/key" }, storage: { class: "fast", size: "1Gi" } },
			h: { provider: "host", secretRefs: { KEY: "env:HOST_SECRET_NAME" } },
		});
		const b = toPublicProfile(profiles.b!);
		expect(b).toEqual({
			id: "b",
			provider: "bwrap",
			preparation: "fleet",
			network: "host",
			secretRefNames: ["KEY"],
		});
		const k = toPublicProfile(profiles.k!);
		expect(k).toEqual({
			id: "k",
			provider: "kubernetes",
			preparation: "provider",
			storageClassName: "fast",
			secretRefNames: ["KEY"],
		});
		const h = toPublicProfile(profiles.h!);
		expect(h).toEqual({
			id: "h",
			provider: "host",
			preparation: "fleet",
			secretRefNames: ["KEY"],
		});
		for (const pub of [b, k, h]) {
			const json = JSON.stringify(pub);
			expect(json).not.toContain("executable");
			expect(json).not.toContain("SECRET_VALUE_NAME");
			expect(json).not.toContain("HOST_SECRET_NAME");
			expect(json).not.toContain("secret/key");
		}
	});
});

describe("provider capabilities", () => {
	test("every kind declares capabilities; bwrap and host are fleet-prepared and fleet-visible, kubernetes is neither", () => {
		for (const kind of PROVIDER_KINDS) expect(PROVIDER_CAPABILITIES[kind]).toBeDefined();
		expect(PROVIDER_CAPABILITIES.bwrap).toEqual({
			preparation: "fleet",
			volumeFleetVisible: true,
			secretResolution: "fleet-env",
		});
		expect(PROVIDER_CAPABILITIES.host).toEqual(PROVIDER_CAPABILITIES.bwrap);
		expect(PROVIDER_CAPABILITIES.kubernetes).toEqual({
			preparation: "provider",
			volumeFleetVisible: false,
			secretResolution: "provider",
		});
	});
});
