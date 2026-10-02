/**
 * Provider profiles: declarative descriptions of the external provider
 * executables that manage clone workspaces (`OMP_PROVIDER_PROTO = 1`), stored
 * in the fleet config file under the `providerProfiles` key. Validation is
 * shape-level and total. It never throws; malformed entries come back as
 * typed errors so the config loader can drop them with an actionable warning
 * and still boot. `toPublicProfile` derives the secret-free capability view
 * that is safe to cross trust boundaries (roster frames, `/ctl/debug`):
 * secret references appear as names only, never values.
 */

/** A provider profile, keyed by `id` in the config file's `providerProfiles` map. */
export interface ProviderProfile {
	/** Profile id; always the map key the profile is stored under. */
	id: string;
	provider: "bwrap" | "kubernetes";
	/** Provider executable path (absolute, on PATH, or `~`-prefixed). */
	executable: string;
	/** Runtime tools this profile permits/requires. */
	tools: string[];
	/** Optional resource limits (e.g. `cpu: "500m"`, `memory: "512Mi"`). */
	resources?: { cpu?: string; memory?: string };
	/** Optional storage (k8s StorageClass name / PVC size). */
	storage?: { class?: string; size?: string };
	/** Secret name → external secret reference. Values never leave the daemon. */
	secretRefs?: Record<string, string>;
	/** Container image (kubernetes profiles). */
	image?: string;
	/** Target namespace (kubernetes profiles). */
	namespace?: string;
	/** Kubernetes only: operator-explicit kubeconfig context (never the ambient current-context). */
	context?: string;
	/**
	 * Sandbox network mode (bwrap profiles): "host" shares the host network
	 * namespace: dev profiles reach the fleet's loopback callback URL, and
	 * "isolated" (absent = default) keeps the fresh netns and requires an
	 * HTTPS callback URL routable from inside. Additive; never inferred.
	 */
	network?: "host" | "isolated";
}

/** One dropped (or wholly malformed) profile entry, with an actionable reason. */
export interface ProfileError {
	/** Shape problems are `invalid_request`; id/key mismatches are `invalid_identity`. */
	code: "invalid_request" | "invalid_identity";
	/** Human-readable, actionable reason the profile was rejected. */
	message: string;
	/** Profile the error applies to (its map key; `""` when the map itself is unusable). */
	profileId: string;
}

export interface ProfileValidationResult {
	/** Valid profiles keyed by id (file order preserved). */
	profiles: Record<string, ProviderProfile>;
	/** One error per dropped entry, or a single error when the map itself is malformed. */
	errors: ProfileError[];
}

/**
 * Validate a raw `providerProfiles` value from the config file. Total: never
 * throws, tolerates unknown keys inside profiles, and returns only shape-valid
 * profiles. The map key is authoritative: a profile's `id` (when present) must
 * match it, and each returned profile's `id` is always its map key.
 */
export function validateProfiles(raw: unknown): ProfileValidationResult {
	if (raw === undefined) return { profiles: {}, errors: [] };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return {
			profiles: {},
			errors: [
				{
					code: "invalid_request",
					message: `providerProfiles must be an object mapping profile id to profile, got ${describeValue(raw)}`,
					profileId: "",
				},
			],
		};
	}
	const profiles: Record<string, ProviderProfile> = {};
	const errors: ProfileError[] = [];
	for (const [key, value] of Object.entries(raw)) {
		const profile = parseProfile(key, value, errors);
		if (profile !== undefined) profiles[key] = profile;
	}
	return { profiles, errors };
}

// The secret-free capability view is a WIRE type: single-sourced in
// shared/protocol.ts (frozen contract) so browser/CLI consumers import it
// from the shared protocol module, never from this fleet-private leaf.
// Imported AND re-exported so it is bound locally (toPublicProfile below
// annotates with it) while fleet-local importers keep the same name.
import type { PublicProviderProfile } from "#lib/wire/protocol";
export type { PublicProviderProfile };

/**
 * Derive the public capability view: drops the executable, secret reference
 * values, and image/namespace details; keeps identity, provider, resource
 * limits, storage class name, and secret reference names.
 */
export function toPublicProfile(profile: ProviderProfile): PublicProviderProfile {
	const pub: PublicProviderProfile = { id: profile.id, provider: profile.provider };
	if (profile.resources !== undefined) pub.resources = { ...profile.resources };
	if (profile.storage?.class !== undefined) pub.storageClassName = profile.storage.class;
	if (profile.secretRefs !== undefined) pub.secretRefNames = Object.keys(profile.secretRefs).sort();
	if (profile.network !== undefined) pub.network = profile.network;
	return pub;
}

function parseProfile(
	key: string,
	value: unknown,
	errors: ProfileError[],
): ProviderProfile | undefined {
	const fail = (code: ProfileError["code"], message: string): undefined => {
		errors.push({ code, message, profileId: key });
		return undefined;
	};
	if (key === "" || key === "__proto__") {
		return fail("invalid_identity", "profile key must be a usable non-empty identifier");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return fail("invalid_request", `profile must be an object, got ${describeValue(value)}`);
	}
	const raw = value as Record<string, unknown>;
	const rawId = raw.id;
	if (rawId !== undefined && (typeof rawId !== "string" || rawId !== key)) {
		return fail(
			"invalid_identity",
			typeof rawId === "string"
				? `profile id "${rawId}" does not match its providerProfiles key "${key}"`
				: `profile id must be a string, got ${describeValue(rawId)}`,
		);
	}
	if (raw.provider !== "bwrap" && raw.provider !== "kubernetes") {
		return fail(
			"invalid_request",
			`provider must be "bwrap" or "kubernetes", got ${
				typeof raw.provider === "string" ? `"${raw.provider}"` : describeValue(raw.provider)
			}`,
		);
	}
	if (typeof raw.executable !== "string" || raw.executable.trim() === "") {
		return fail(
			"invalid_request",
			"executable is required: a non-empty path (absolute, on PATH, or ~/ prefixed)",
		);
	}
	if (!isToolList(raw.tools)) {
		return fail("invalid_request", "tools is required: an array of non-empty tool names");
	}
	const profile: ProviderProfile = {
		id: key,
		provider: raw.provider,
		executable: raw.executable,
		tools: raw.tools,
	};

	const resources = raw.resources;
	if (resources !== undefined) {
		if (typeof resources !== "object" || resources === null || Array.isArray(resources)) {
			return fail(
				"invalid_request",
				`resources must be an object with optional "cpu"/"memory" strings, got ${describeValue(resources)}`,
			);
		}
		const r = resources as Record<string, unknown>;
		const out: { cpu?: string; memory?: string } = {};
		if (r.cpu !== undefined) {
			if (typeof r.cpu !== "string" || r.cpu.trim() === "") {
				return fail(
					"invalid_request",
					`resources.cpu must be a non-empty string (e.g. "500m"), got ${describeValue(r.cpu)}`,
				);
			}
			out.cpu = r.cpu;
		}
		if (r.memory !== undefined) {
			if (typeof r.memory !== "string" || r.memory.trim() === "") {
				return fail(
					"invalid_request",
					`resources.memory must be a non-empty string (e.g. "512Mi"), got ${describeValue(r.memory)}`,
				);
			}
			out.memory = r.memory;
		}
		if (Object.keys(out).length > 0) profile.resources = out;
	}

	const storage = raw.storage;
	if (storage !== undefined) {
		if (typeof storage !== "object" || storage === null || Array.isArray(storage)) {
			return fail(
				"invalid_request",
				`storage must be an object with optional "class"/"size" strings, got ${describeValue(storage)}`,
			);
		}
		const s = storage as Record<string, unknown>;
		const out: { class?: string; size?: string } = {};
		if (s.class !== undefined) {
			if (typeof s.class !== "string" || s.class.trim() === "") {
				return fail(
					"invalid_request",
					`storage.class must be a non-empty string, got ${describeValue(s.class)}`,
				);
			}
			out.class = s.class;
		}
		if (s.size !== undefined) {
			if (typeof s.size !== "string" || s.size.trim() === "") {
				return fail(
					"invalid_request",
					`storage.size must be a non-empty string (e.g. "10Gi"), got ${describeValue(s.size)}`,
				);
			}
			out.size = s.size;
		}
		if (Object.keys(out).length > 0) profile.storage = out;
	}

	const secretRefs = raw.secretRefs;
	if (secretRefs !== undefined) {
		if (typeof secretRefs !== "object" || secretRefs === null || Array.isArray(secretRefs)) {
			return fail(
				"invalid_request",
				`secretRefs must be an object mapping secret name to external reference, got ${describeValue(secretRefs)}`,
			);
		}
		for (const [name, ref] of Object.entries(secretRefs)) {
			if (typeof ref !== "string" || ref.trim() === "") {
				return fail(
					"invalid_request",
					`secretRefs."${name}" must be a non-empty external secret reference, got ${describeValue(ref)}`,
				);
			}
		}
		profile.secretRefs = secretRefs as Record<string, string>;
	}

	const image = raw.image;
	if (image !== undefined) {
		if (typeof image !== "string" || image.trim() === "") {
			return fail(
				"invalid_request",
				`image must be a non-empty string, got ${describeValue(image)}`,
			);
		}
		profile.image = image;
	}

	const namespace = raw.namespace;
	if (namespace !== undefined) {
		if (typeof namespace !== "string" || namespace.trim() === "") {
			return fail(
				"invalid_request",
				`namespace must be a non-empty string, got ${describeValue(namespace)}`,
			);
		}
		profile.namespace = namespace;
	}

	const context = raw.context;
	if (context !== undefined) {
		if (typeof context !== "string" || context.trim() === "") {
			return fail(
				"invalid_request",
				`context must be a non-empty string, got ${describeValue(context)}`,
			);
		}
		profile.context = context;
	}

	const network = raw.network;
	if (network !== undefined && network !== "host" && network !== "isolated") {
		return fail(
			"invalid_request",
			`network must be "host" or "isolated", got ${
				typeof network === "string" ? `"${network}"` : describeValue(network)
			}`,
		);
	}
	if (network !== undefined) profile.network = network;

	return profile;
}

function isToolList(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((tool) => typeof tool === "string" && tool.trim() !== "")
	);
}

function describeValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	switch (typeof value) {
		case "string":
			return `"${value}"`;
		case "number":
		case "boolean":
			return String(value);
		case "undefined":
			return "undefined";
		default:
			return "an object";
	}
}
