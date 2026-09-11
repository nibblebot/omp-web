/**
 * Provider operation protocol (OMP_PROVIDER_PROTO = 2) — the frozen contract
 * for fleet-side clone-workspace sandbox providers (P5.1). Encoding, request
 * shape, response shape, identity/supervision rules and the error vocabulary
 * are fixed by docs/clone-contracts.md ("Provider operation protocol (frozen
 * contract)") and supersede the earlier "Provider executable contract" draft.
 *
 * v2 adds `providerProto` (present and equal on both directions, rejected
 * before dispatch otherwise) and the Kubernetes resource binding: a
 * Kubernetes request carries `kubernetes` (the namespace identity its
 * resources are bound to) and a successful Kubernetes response carries
 * `kubernetes` (the namespace/pod/PVC API uids it observed).
 *
 * Invocation: the fleet runs `<executable> <op>` with exactly one JSON
 * request on stdin and exactly one JSON response on stdout; stderr is a
 * human log the fleet never parses. Exit 0 means a response was produced on
 * stdout; the response envelope itself carries the typed success or failure
 * (an `ok:false` envelope is a *successful* invocation whose operation
 * failed — classified by code, not by exit status). A non-zero exit with no
 * parseable response means the provider itself failed to operate.
 *
 * Safety rules enforced here (P5.5 never negotiable):
 * - No secrets travel in requests. Profiles reference secrets by name only
 *   (`secretRefs` values must be external secret references, never
 *   materialized values), and key allowlists reject unknown/extra fields at
 *   every nesting level so secret-shaped material cannot be smuggled in.
 * - All JSON I/O is size-bounded: requests and responses are capped at 1 MiB.
 * - State supervision is identity-based. Per-workspace `stateDir` holds the
 *   pidfile `provider.pid.json` = {pid, procStartTime, generation,
 *   workspaceToken}; `procStartTime` comes from `/proc/<pid>/stat` field 22,
 *   recorded at launch, and the launch token is embedded in the workspace
 *   process argv. Liveness requires the pid alive AND its procStartTime
 *   unchanged AND its cmdline still carrying the token; `stop` must prove
 *   the generation terminated by that identity, never by PID alone.
 *
 * Pure module except the pidfile helpers (small, intended POSIX reads): no
 * process spawning. Spawning lives in runtime/provider-exec.ts.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const utf8 = new TextEncoder();

/** Provider protocol version; the fleet pins it before invoking any provider. */
export const OMP_PROVIDER_PROTO = 2;

/** Serialized request/response cap: one JSON document per invocation (1 MiB). */
export const PROVIDER_JSON_MAX_BYTES = 1024 * 1024;

/** Pidfile name the provider's per-workspace `stateDir` holds. */
export const PROVIDER_PID_FILE = "provider.pid.json";

/** Operation kinds; the fleet invokes the executable with one of these. */
export const PROVIDER_OPS = ["ensure-running", "inspect", "stop", "delete"] as const;
export type ProviderOp = (typeof PROVIDER_OPS)[number];

/** Lifecycle observation the provider reports for a workspace. */
export type ProviderObserved = "running" | "stopped" | "missing";

/**
 * Opaque, provider-namespaced handle: the provider's durable identity for the
 * resource it manages for this workspace. The fleet treats it as a private
 * opaque token — it never inspects it and it never crosses trust boundaries
 * (roster frames, /ctl/debug). Same workspace/generation → same handle; the
 * provider rediscoverable by durable identity, never by PID alone. Non-empty
 * and bounded; absent only until the provider has created the resource.
 */
export type ProviderHandle = string;

/**
 * Kubernetes resource binding (P5.3): the durable namespace identity a
 * workspace's Pod/PVC live in, fixed once at registration and never
 * re-resolved implicitly. `resourceIdentity` is 16 random bytes as lowercase
 * hex, generated once by the fleet; the Pod name, the PVC name and the
 * provider's private state directory all derive from it, so it must never
 * change for a workspace.
 */
export interface KubernetesBinding {
	/** 32 lowercase hex characters (see {@link newResourceIdentity}). */
	resourceIdentity: string;
	/** Operator-explicit kubeconfig context; never the ambient current-context. */
	context: string;
	/** Operator-prepared namespace the workspace's resources live in. */
	namespace: string;
	/** API uid of that namespace, captured at registration. */
	namespaceUid: string;
}

/**
 * Kubernetes objects one operation observed, by API uid. `null` means the
 * object is absent. The namespace uid is always reported so the fleet can
 * detect a namespace replaced underneath a live workspace.
 */
export interface KubernetesObserved {
	namespaceUid: string;
	podUid: string | null;
	pvcUid: string | null;
}

/** Resource-identity width: 16 random bytes, lowercase hex. */
export const RESOURCE_IDENTITY_BYTES = 16;

/** Resource-identity shape: 32 lowercase hex characters. */
export const RESOURCE_IDENTITY_RE = /^[0-9a-f]{32}$/;

const NAMESPACE_UID_MAX_CHARS = 128;

/**
 * Generate a fresh resource identity: 16 random bytes as lowercase hex. The
 * Pod name, PVC name and provider state directory all derive from it, so the
 * fleet persists the result and reuses it verbatim forever after.
 */
export function newResourceIdentity(): string {
	return randomBytes(RESOURCE_IDENTITY_BYTES).toString("hex");
}

const KUBERNETES_SOURCE_SCHEMES = ["git", "https", "ssh"] as const;
const SSH_USERNAME_RE = /^[A-Za-z0-9._~-]+$/;
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const HOST_MAX_CHARS = 253;
const PORT_RE = /^[0-9]{1,5}$/;
const PATH_SEGMENT_RE = /^[^\s?#\\:]+$/;
const KUBERNETES_SOURCE_MAX_CHARS = 4096;

/**
 * Validate a Kubernetes clone source: an absolute `git:`, `https:`, or
 * `ssh:` URL naming a host and a repository path. An SSH username is
 * allowed; passwords, any other URL userinfo, whitespace, query strings,
 * fragments, backslashes, local paths, `file:` URLs, and option/helper
 * syntax are rejected.
 *
 * Returns the validated source text unchanged — it is preserved verbatim for
 * pin resolution and for the workspace's source-pin digest. Throws
 * ProviderProtocolError("invalid_request").
 */
export function validateKubernetesSource(value: unknown): string {
	const reject = (why: string): never => {
		throw ProviderProtocolError.invalidRequest(`invalid kubernetes source: ${why}`);
	};
	if (typeof value !== "string" || value.length === 0) reject("must be a non-empty string");
	const source = value as string;
	if (source.length > KUBERNETES_SOURCE_MAX_CHARS) {
		reject(`exceeds ${KUBERNETES_SOURCE_MAX_CHARS} characters`);
	}
	if (source.includes("\0")) reject("must not contain NUL");
	if (/\s/.test(source)) reject("must not contain whitespace");
	if (source.includes("\\")) reject("must not contain backslashes");
	if (source.includes("?") || source.includes("#")) reject("must not carry a query or fragment");
	const separator = source.indexOf("://");
	if (separator <= 0) reject("must be an absolute git://, https://, or ssh:// URL");
	const scheme = source.slice(0, separator).toLowerCase();
	if (!(KUBERNETES_SOURCE_SCHEMES as readonly string[]).includes(scheme)) {
		reject(
			`unsupported scheme ${JSON.stringify(scheme)}; only git://, https://, and ssh:// are allowed`,
		);
	}
	const rest = source.slice(separator + 3);
	const slash = rest.indexOf("/");
	const authority = slash < 0 ? rest : rest.slice(0, slash);
	const pathPart = slash < 0 ? "" : rest.slice(slash);
	if (authority.length === 0) reject("must name a host");
	if (pathPart.length <= 1) reject("must include a repository path");
	const at = authority.lastIndexOf("@");
	let hostPort = authority;
	if (at >= 0) {
		const userinfo = authority.slice(0, at);
		hostPort = authority.slice(at + 1);
		if (scheme !== "ssh") reject("only ssh:// sources may carry a username");
		if (userinfo.includes(":")) reject("must not carry a password");
		if (userinfo.length === 0 || !SSH_USERNAME_RE.test(userinfo)) {
			reject("has an invalid SSH username");
		}
	}
	if (hostPort.startsWith("[")) {
		const close = hostPort.indexOf("]");
		if (close < 0) reject("has an unterminated IPv6 host");
		const tail = hostPort.slice(close + 1);
		if (tail !== "" && !tail.startsWith(":")) reject("has an invalid host");
		hostPort = hostPort.slice(1, close);
	} else {
		const colon = hostPort.lastIndexOf(":");
		if (colon >= 0) {
			const portRaw = hostPort.slice(colon + 1);
			hostPort = hostPort.slice(0, colon);
			if (!PORT_RE.test(portRaw)) reject("has an invalid port");
			const port = Number(portRaw);
			if (port < 1 || port > 65535) reject("has an out-of-range port");
		}
		if (hostPort.length === 0 || hostPort.length > HOST_MAX_CHARS || !HOST_RE.test(hostPort)) {
			reject(`has an invalid host ${JSON.stringify(hostPort)}`);
		}
		if (hostPort.includes("..")) reject("has an invalid host");
	}
	for (const segment of pathPart.slice(1).split("/")) {
		if (segment.length === 0) reject("must not contain empty path segments");
		if (segment === "." || segment === "..") reject("must not contain relative path segments");
		if (!PATH_SEGMENT_RE.test(segment)) {
			reject(`has an invalid path segment ${JSON.stringify(segment)}`);
		}
	}
	return source;
}

/**
 * Provider error codes spelled in the fleet lifecycle vocabulary: invalid
 * input and conflicts keep their codes, an unavailable dependency is
 * `unavailable`, a timeout is `retryable`, and an internal failure is
 * `provider_failed`.
 */
export type ProviderLifecycleErrorCode =
	| "invalid_request"
	| "conflict"
	| "unavailable"
	| "retryable"
	| "provider_failed";

export function providerErrorToLifecycleCode(code: ProviderErrorCode): ProviderLifecycleErrorCode {
	switch (code) {
		case "invalid_request":
			return "invalid_request";
		case "conflict":
			return "conflict";
		case "unavailable":
			return "unavailable";
		case "timeout":
			return "retryable";
		default:
			return "provider_failed";
	}
}

/**
 * Source-pin digest: lowercase SHA-256 of the UTF-8 JSON tuple
 * `[source.remote, revision, branch]`. Stored on the Pod and PVC (annotation)
 * and compared against the request tuple + provider state so a workspace's
 * checkout can never silently change pin underneath a retained volume.
 */
export function computeSourcePinDigest(
	sourceRemote: string,
	revision: string,
	branch: string,
): string {
	return createHash("sha256")
		.update(JSON.stringify([sourceRemote, revision, branch]), "utf8")
		.digest("hex");
}

/**
 * Typed error vocabulary for provider operations, reusing the frozen ledger
 * vocabulary (docs/clone-contracts.md "Typed errors").
 */
export const PROVIDER_ERROR_CODES = [
	"invalid_request",
	"unavailable",
	"conflict",
	"internal",
	"timeout",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/**
 * A provider profile — structurally the fleet config's ProviderProfile
 * (fleet/provider-profile.ts, P1.3) minus the config-file editing concern.
 * `secretRefs` holds external secret reference NAMES only; values never
 * leave the config file and never appear in requests.
 */
export interface ProviderProfile {
	id: string;
	provider: "bwrap" | "kubernetes";
	executable: string;
	tools: string[];
	resources?: { cpu?: string; memory?: string };
	storage?: { class?: string; size?: string };
	secretRefs?: Record<string, string>;
	image?: string;
	namespace?: string;
	/** Kubernetes only: operator-explicit kubeconfig context. The provider
	 *  never falls back to the ambient current-context (P5.3). */
	context?: string;
	/** Sandbox network mode (bwrap): "host" shares the host netns (dev profiles), "isolated" (default) keeps the fresh netns. */
	network?: "host" | "isolated";
}

/** Fixed request field key set (steers `Object.keys` allowlist, see below). */
const PROVIDER_REQUEST_KEYS = [
	"providerProto",
	"op",
	"workspaceId",
	"generation",
	"workspaceDir",
	"homeDir",
	"profile",
	"handle",
	"stateDir",
	"kubernetes",
	"source",
	"revision",
	"branch",
	"baseline",
] as const;

/** Sanitized-baseline document key set (see {@link ProviderBaseline}). */
const PROVIDER_BASELINE_KEYS = ["configYaml", "modelsYaml"] as const;

/** Kubernetes resource-binding key set (see {@link KubernetesBinding}). */
const KUBERNETES_BINDING_KEYS = [
	"resourceIdentity",
	"context",
	"namespace",
	"namespaceUid",
] as const;

const PROVIDER_PROFILE_KEYS = [
	"id",
	"provider",
	"executable",
	"tools",
	"resources",
	"storage",
	"secretRefs",
	"image",
	"namespace",
	"context",
	"network",
] as const;

const PROVIDER_RESOURCES_KEYS = ["cpu", "memory"] as const;
const PROVIDER_STORAGE_KEYS = ["class", "size"] as const;

/** Fixed source key set: exactly one of `local`/`remote` when present. */
const PROVIDER_SOURCE_KEYS = ["local", "remote"] as const;

/**
 * Reference-shaped secret values: a name or reference for the fleet to
 * resolve, never materialized secret material. Blocks whitespace, control
 * characters, and anything reserved/secret-like (long random blobs are still
 * reference-shaped, but this is the fleet's own config vocabulary, not a
 * passphrase field — real secrets live behind the reference).
 */
const SECRET_REF_RE = /^[A-Za-z0-9._~:/@+-]+$/;

/** Handle bound: opaque tokens are bounded like the rest of the protocol. */
const HANDLE_MAX_BYTES = 4096;
/** Reference bound: external secret references are short names. */
const SECRET_REF_MAX_CHARS = 512;
/**
 * Single-document bound for baseline YAML. The sanitized config is a few
 * hundred bytes in practice; a custom-provider `models.yml` is the only
 * document that grows, and both stay far below the 1 MiB request cap.
 */
const BASELINE_DOC_MAX_CHARS = 256 * 1024;

/**
 * Sanitized sandbox baseline documents (P5.5) for profiles that prepare
 * their volume in-pod: the fleet runs the single seed authority
 * (runtime/sandbox-baseline.ts) and ships its output so a provider that
 * cannot see the operator's agent dir still boots the sandbox with the same
 * agent-behavior config as a fleet-side prepared (bwrap) volume.
 *
 * Untrusted-input discipline: both documents are already allowlist-filtered
 * and credential-free, and the provider treats them as opaque bytes. They are
 * NEVER a channel for credentials — `secretRefs` is the only credential path.
 */
export interface ProviderBaseline {
	/** Sanitized `config.yml` document (allowlisted keys, roles pre-filtered). */
	configYaml: string;
	/** Sanitized `models.yml` document, when the operator defines one. */
	modelsYaml?: string;
}

/** The per-workspace identity record in the provider's private `stateDir`. */
export interface ProviderPidFile {
	/** OS pid the provider launched for this workspace. */
	pid: number;
	/**
	 * Process start time, `/proc/<pid>/stat` field 22, recorded at launch.
	 * The identity pair (pid, procStartTime) is what survives a PID reuse.
	 */
	procStartTime: number;
	/** Authorized generation recorded at launch; stop binds its proof to it. */
	generation: number;
	/**
	 * Launch token embedded in the workspace process argv; liveness requires
	 * `/proc/<pid>/cmdline` to contain it (see matchProviderPidFile). Stays
	 * in the provider's private stateDir — never in requests.
	 */
	workspaceToken: string;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Typed protocol error carrying a ledger error code. Default retryability is
 * code-derived: `unavailable` and `timeout` are retryable; `invalid_request`
 * and `internal` are not. Provider-authored error envelopes carry their own
 * explicit `retryable` flag (honored by ProviderOpError).
 */
export class ProviderProtocolError extends Error {
	readonly code: ProviderErrorCode;
	readonly retryable: boolean;

	constructor(code: ProviderErrorCode, message: string, opts?: { cause?: unknown }) {
		super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
		this.name = "ProviderProtocolError";
		this.code = code;
		this.retryable = code === "unavailable" || code === "timeout";
	}

	/** Convenience factories so call sites read as intent, not constructor noise. */
	static invalidRequest(message: string, opts?: { cause?: unknown }): ProviderProtocolError {
		return new ProviderProtocolError("invalid_request", message, opts);
	}
	static unavailable(message: string, opts?: { cause?: unknown }): ProviderProtocolError {
		return new ProviderProtocolError("unavailable", message, opts);
	}
	static internal(message: string, opts?: { cause?: unknown }): ProviderProtocolError {
		return new ProviderProtocolError("internal", message, opts);
	}
}

export function isProviderProtocolError(value: unknown): value is ProviderProtocolError {
	return value instanceof ProviderProtocolError;
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/** One provider operation request (frozen contract). */
export interface ProviderRequest {
	/** Protocol version this request was written against; must equal OMP_PROVIDER_PROTO. */
	providerProto: number;
	op: ProviderOp;
	workspaceId: string;
	/** Desired runtime generation: positive integer, monotonic, never reused. */
	generation: number;
	/** The checkout directory of the workspace. */
	workspaceDir: string;
	/** The private writable home directory of the workspace. */
	homeDir: string;
	profile: ProviderProfile;
	/** Opaque provider-owned token; absent before the resource exists. */
	handle?: ProviderHandle;
	/** Provider-private per-workspace supervision directory. */
	stateDir: string;
	/**
	 * Kubernetes resource binding: required for every kubernetes-profile
	 * operation, rejected on bwrap profiles. The provider validates every
	 * object it touches against it.
	 */
	kubernetes?: KubernetesBinding;
	/**
	 * Clone source (exactly one member), additive for provider-side volume
	 * initialization (kubernetes in-pod PVC init); bwrap clones are prepared
	 * fleet-side and ignore it. `local` is a fleet-host filesystem path and is
	 * meaningless in-cluster — kubernetes providers reject it.
	 */
	source?: { local?: string; remote?: string };
	/** The pinned full commit (fleet-resolved once via resolveWorkspacePin). */
	revision?: string;
	/** The workspace branch created at the pin. */
	branch?: string;
	/**
	 * Sanitized sandbox baseline documents; the fleet supplies them for
	 * profiles that prepare their volume provider-side (kubernetes), which
	 * cannot read the operator's agent dir themselves. Fleet-side prepared
	 * profiles (bwrap) already seeded their volume and omit it.
	 */
	baseline?: ProviderBaseline;
}

interface ValidateProviderOptions {
	/** Serialized-size cap; defaults to PROVIDER_JSON_MAX_BYTES. */
	maxBytes?: number;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			throw ProviderProtocolError.invalidRequest(
				`invalid provider request: ${where}.${key} is not a recognized field`,
			);
		}
	}
}

function requireString(
	value: Record<string, unknown>,
	field: string,
	where: string,
	opts?: { maxChars?: number },
): string {
	const v = value[field];
	if (typeof v !== "string" || v.length === 0 || v.includes("\0")) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.${field} must be a non-empty string`,
		);
	}
	if (opts?.maxChars !== undefined && v.length > opts.maxChars) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.${field} exceeds ${opts.maxChars} characters`,
		);
	}
	return v;
}

function optionalString(
	value: Record<string, unknown>,
	field: string,
	where: string,
	opts?: { maxChars?: number },
): string | undefined {
	const v = value[field];
	if (v === undefined) return undefined;
	if (typeof v !== "string" || v.length === 0 || v.includes("\0")) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.${field} must be a non-empty string when present`,
		);
	}
	if (opts?.maxChars !== undefined && v.length > opts.maxChars) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.${field} exceeds ${opts.maxChars} characters`,
		);
	}
	return v;
}

function parseProfile(value: unknown, where: string): ProviderProfile {
	if (!isPlainRecord(value)) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where} must be an object`,
		);
	}
	rejectUnknownKeys(value, PROVIDER_PROFILE_KEYS, where);
	const provider = value["provider"];
	if (provider !== "bwrap" && provider !== "kubernetes") {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.provider must be "bwrap" or "kubernetes"`,
		);
	}
	const secretRefsRaw = value["secretRefs"];
	let secretRefs: Record<string, string> | undefined;
	if (secretRefsRaw !== undefined) {
		if (!isPlainRecord(secretRefsRaw) || Object.keys(secretRefsRaw).length === 0) {
			throw ProviderProtocolError.invalidRequest(
				`invalid provider request: ${where}.secretRefs must be a non-empty object`,
			);
		}
		secretRefs = {};
		// Values are external secret reference names ONLY — never materialized
		// secrets (P5.5). Reference-shaped values are enforced here so a
		// secret cannot be smuggled into a request.
		for (const [name, ref] of Object.entries(secretRefsRaw)) {
			if (typeof ref !== "string" || ref.length === 0 || ref.length > SECRET_REF_MAX_CHARS) {
				throw ProviderProtocolError.invalidRequest(
					`invalid provider request: ${where}.secretRefs.${name} must be a string reference`,
				);
			}
			if (!SECRET_REF_RE.test(ref)) {
				throw ProviderProtocolError.invalidRequest(
					`invalid provider request: ${where}.secretRefs.${name} is not a reference-shaped value (names only, never secret material)`,
				);
			}
			secretRefs[name] = ref;
		}
	}
	let resources: { cpu?: string; memory?: string } | undefined;
	if (value["resources"] !== undefined) {
		const resourcesRaw = value["resources"];
		if (!isPlainRecord(resourcesRaw)) {
			throw ProviderProtocolError.invalidRequest(
				`invalid provider request: ${where}.resources must be an object`,
			);
		}
		rejectUnknownKeys(resourcesRaw, PROVIDER_RESOURCES_KEYS, `${where}.resources`);
		resources = {
			cpu: optionalString(resourcesRaw, "cpu", `${where}.resources`),
			memory: optionalString(resourcesRaw, "memory", `${where}.resources`),
		};
	}
	let storage: { class?: string; size?: string } | undefined;
	if (value["storage"] !== undefined) {
		const storageRaw = value["storage"];
		if (!isPlainRecord(storageRaw)) {
			throw ProviderProtocolError.invalidRequest(
				`invalid provider request: ${where}.storage must be an object`,
			);
		}
		rejectUnknownKeys(storageRaw, PROVIDER_STORAGE_KEYS, `${where}.storage`);
		storage = {
			class: optionalString(storageRaw, "class", `${where}.storage`),
			size: optionalString(storageRaw, "size", `${where}.storage`),
		};
	}
	const toolsRaw = value["tools"];
	if (!Array.isArray(toolsRaw) || toolsRaw.some((t) => typeof t !== "string" || t.length === 0)) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.tools must be an array of non-empty strings`,
		);
	}
	const networkRaw = value["network"];
	if (networkRaw !== undefined && networkRaw !== "host" && networkRaw !== "isolated") {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.network must be "host" or "isolated"`,
		);
	}
	return {
		id: requireString(value, "id", where),
		provider,
		executable: requireString(value, "executable", where),
		tools: toolsRaw as string[],
		resources,
		storage,
		secretRefs,
		image: optionalString(value, "image", where),
		namespace: optionalString(value, "namespace", where),
		context: optionalString(value, "context", where, { maxChars: 512 }),
		...(networkRaw !== undefined ? { network: networkRaw as "host" | "isolated" } : {}),
	};
}

/** Parse a Kubernetes resource binding through the strict allowlist. */
function parseKubernetesBinding(value: unknown, where: string): KubernetesBinding {
	if (!isPlainRecord(value)) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where} must be an object`,
		);
	}
	rejectUnknownKeys(value, KUBERNETES_BINDING_KEYS, where);
	const resourceIdentity = requireString(value, "resourceIdentity", where);
	if (!RESOURCE_IDENTITY_RE.test(resourceIdentity)) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.resourceIdentity must be 32 lowercase hex characters`,
		);
	}
	return {
		resourceIdentity,
		context: requireString(value, "context", where, { maxChars: 512 }),
		namespace: requireString(value, "namespace", where, { maxChars: 253 }),
		namespaceUid: requireString(value, "namespaceUid", where, {
			maxChars: NAMESPACE_UID_MAX_CHARS,
		}),
	};
}

/**
 * Validate an untrusted value as a provider request and return it narrowed.
 * Strict key allowlists at every level (unknown fields are rejected, so
 * secret-shaped material cannot be smuggled in); `generation` must be a
 * positive safe integer; the profile is strict per the frozen shape (tools
 * an array of non-empty strings, secretRefs reference-shaped names only);
 * `handle`, when present, a non-empty bounded opaque string. Throws
 * ProviderProtocolError("invalid_request").
 */
export function validateProviderRequest(value: unknown): ProviderRequest {
	if (!isPlainRecord(value)) {
		throw ProviderProtocolError.invalidRequest("invalid provider request: expected an object");
	}
	rejectUnknownKeys(value, PROVIDER_REQUEST_KEYS, "provider request");
	const providerProto = value["providerProto"];
	if (providerProto !== OMP_PROVIDER_PROTO) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: providerProto must be ${OMP_PROVIDER_PROTO}, got ${JSON.stringify(providerProto)}; a request written against another protocol version is never dispatched`,
		);
	}
	const op = value["op"];
	if (typeof op !== "string" || !PROVIDER_OPS.includes(op as ProviderOp)) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: op must be one of ${PROVIDER_OPS.join("|")}`,
		);
	}
	const generation = value["generation"];
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
		throw ProviderProtocolError.invalidRequest(
			"invalid provider request: generation must be a positive safe integer",
		);
	}
	const handle = value["handle"];
	if (
		handle !== undefined &&
		(typeof handle !== "string" || handle.length === 0 || handle.length > HANDLE_MAX_BYTES)
	) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: handle must be a non-empty opaque string of at most ${HANDLE_MAX_BYTES} bytes`,
		);
	}
	const sourceRaw = value["source"];
	let source: ProviderRequest["source"];
	if (sourceRaw !== undefined) {
		if (!isPlainRecord(sourceRaw)) {
			throw ProviderProtocolError.invalidRequest(
				"invalid provider request: source must be an object",
			);
		}
		rejectUnknownKeys(sourceRaw, PROVIDER_SOURCE_KEYS, "provider request.source");
		source = {
			local: optionalString(sourceRaw, "local", "provider request.source", { maxChars: 4096 }),
			remote: optionalString(sourceRaw, "remote", "provider request.source", { maxChars: 4096 }),
		};
		if ((source.local === undefined) === (source.remote === undefined)) {
			throw ProviderProtocolError.invalidRequest(
				"invalid provider request: source must have exactly one of local|remote",
			);
		}
	}
	const kubernetesRaw = value["kubernetes"];
	let kubernetes: KubernetesBinding | undefined;
	if (kubernetesRaw !== undefined) {
		kubernetes = parseKubernetesBinding(kubernetesRaw, "provider request.kubernetes");
	}
	const request: ProviderRequest = {
		providerProto: OMP_PROVIDER_PROTO,
		op: op as ProviderOp,
		workspaceId: requireString(value, "workspaceId", "provider request"),
		generation,
		workspaceDir: requireString(value, "workspaceDir", "provider request"),
		homeDir: requireString(value, "homeDir", "provider request"),
		profile: parseProfile(value["profile"], "provider request.profile"),
		stateDir: requireString(value, "stateDir", "provider request"),
	};
	if (kubernetes !== undefined) request.kubernetes = kubernetes;
	if (kubernetes !== undefined && request.profile.provider !== "kubernetes") {
		throw ProviderProtocolError.invalidRequest(
			"invalid provider request: kubernetes is only meaningful on a kubernetes profile",
		);
	}
	if (request.profile.provider === "kubernetes" && kubernetes === undefined) {
		throw ProviderProtocolError.invalidRequest(
			"invalid provider request: a kubernetes profile requires the kubernetes resource binding",
		);
	}
	if (handle !== undefined) request.handle = handle;
	if (source !== undefined) request.source = source;
	const revision = optionalString(value, "revision", "provider request", { maxChars: 512 });
	if (revision !== undefined) request.revision = revision;
	const branch = optionalString(value, "branch", "provider request", { maxChars: 512 });
	if (branch !== undefined) request.branch = branch;
	const baselineRaw = value["baseline"];
	if (baselineRaw !== undefined) {
		if (!isPlainRecord(baselineRaw)) {
			throw ProviderProtocolError.invalidRequest(
				"invalid provider request: baseline must be an object",
			);
		}
		rejectUnknownKeys(baselineRaw, PROVIDER_BASELINE_KEYS, "provider request.baseline");
		const configYaml = requireString(baselineRaw, "configYaml", "provider request.baseline", {
			maxChars: BASELINE_DOC_MAX_CHARS,
		});
		const modelsYaml = optionalString(baselineRaw, "modelsYaml", "provider request.baseline", {
			maxChars: BASELINE_DOC_MAX_CHARS,
		});
		request.baseline = { configYaml, ...(modelsYaml !== undefined ? { modelsYaml } : {}) };
	}
	return request;
}

function parseWithByteBound(raw: string, maxBytes: number, what: string): unknown {
	const length = utf8.encode(raw).length;
	if (length > maxBytes) {
		throw ProviderProtocolError.invalidRequest(
			`${what} is ${length} bytes, over the ${maxBytes}-byte limit`,
		);
	}
	try {
		return JSON.parse(raw) as unknown;
	} catch (cause) {
		throw ProviderProtocolError.invalidRequest(`${what} is not valid JSON`, { cause });
	}
}

/**
 * Parse a raw (untrusted) request payload: byte-bound, JSON.parse, then
 * strict validation. Throws ProviderProtocolError("invalid_request").
 */
export function parseProviderRequest(raw: string, opts?: ValidateProviderOptions): ProviderRequest {
	const maxBytes = opts?.maxBytes ?? PROVIDER_JSON_MAX_BYTES;
	return validateProviderRequest(parseWithByteBound(raw, maxBytes, "provider request"));
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Provider response envelope keys (unknown keys rejected, see below). */
const PROVIDER_OK_KEYS = [
	"ok",
	"providerProto",
	"handle",
	"observed",
	"kubernetes",
	"pid",
	"startedAt",
] as const;
const PROVIDER_ERROR_KEYS = ["ok", "providerProto", "error"] as const;
const PROVIDER_ERROR_OBJECT_KEYS = ["code", "message", "retryable"] as const;

/** Kubernetes observation key set (see {@link KubernetesObserved}). */
const KUBERNETES_OBSERVED_KEYS = ["namespaceUid", "podUid", "pvcUid"] as const;

/** Successful operation envelope. */
export interface ProviderOkResponse {
	ok: true;
	/** Protocol version this response was written against; must equal OMP_PROVIDER_PROTO. */
	providerProto: number;
	/** Opaque provider-namespaced handle; equals the request's handle when one was carried. */
	handle: ProviderHandle;
	/** Runtime observation; `running` implies a live resource for the current generation. */
	observed: ProviderObserved;
	/**
	 * Kubernetes objects observed by this operation, by API uid. Present on
	 * every successful kubernetes-profile response (the fleet cross-checks it
	 * against the binding it sent).
	 */
	kubernetes?: KubernetesObserved;
	/** Live process pid, when the resource runs a process the provider can name. */
	pid?: number;
	/** Epoch ms when a live process was last (re)started. */
	startedAt?: number;
}

/** Typed failure envelope: the invocation succeeded, the operation failed. */
export interface ProviderErrorResponse {
	ok: false;
	/** Protocol version this response was written against; must equal OMP_PROVIDER_PROTO. */
	providerProto: number;
	error: {
		code: ProviderErrorCode;
		message: string;
		/** True when retrying the same operation is a safe, likely-successful next step. */
		retryable: boolean;
	};
}

/** One provider operation response (frozen contract). */
export type ProviderResponse = ProviderOkResponse | ProviderErrorResponse;

function requireStringField(value: Record<string, unknown>, field: string, where: string): string {
	const v = value[field];
	if (typeof v !== "string" || v.length === 0 || v.includes("\0")) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider response: ${where}.${field} must be a non-empty string`,
		);
	}
	return v;
}

function parseOkResponse(value: Record<string, unknown>): ProviderOkResponse {
	const observed = value["observed"];
	if (observed !== "running" && observed !== "stopped" && observed !== "missing") {
		throw ProviderProtocolError.invalidRequest(
			'provider response: observed must be "running", "stopped", or "missing"',
		);
	}
	const kubernetes = parseKubernetesObserved(value["kubernetes"]);
	const pid = value["pid"];
	if (pid !== undefined && (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 1)) {
		throw ProviderProtocolError.invalidRequest(
			"provider response: pid must be a positive safe integer",
		);
	}
	const startedAt = value["startedAt"];
	if (
		startedAt !== undefined &&
		(typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0)
	) {
		throw ProviderProtocolError.invalidRequest(
			"provider response: startedAt must be a non-negative number",
		);
	}
	const response: ProviderOkResponse = {
		ok: true,
		providerProto: OMP_PROVIDER_PROTO,
		handle: requireStringField(value, "handle", "provider response"),
		observed,
		pid,
		startedAt,
	};
	if (kubernetes !== undefined) response.kubernetes = kubernetes;
	return response;
}

/** Parse a nullable bounded string field (`null` = absent object). */
function nullableStringField(
	value: Record<string, unknown>,
	field: string,
	where: string,
): string | null {
	const raw = value[field];
	if (raw === null) return null;
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 128 || raw.includes("\0")) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider response: ${where}.${field} must be a bounded non-empty string or null`,
		);
	}
	return raw;
}

/** Parse an optional Kubernetes observation object; undefined when absent. */
function parseKubernetesObserved(value: unknown): KubernetesObserved | undefined {
	if (value === undefined) return undefined;
	if (!isPlainRecord(value)) {
		throw ProviderProtocolError.invalidRequest("provider response: kubernetes must be an object");
	}
	rejectUnknownKeys(value, KUBERNETES_OBSERVED_KEYS, "provider response.kubernetes");
	return {
		namespaceUid: requireStringField(value, "namespaceUid", "provider response.kubernetes"),
		podUid: nullableStringField(value, "podUid", "provider response.kubernetes"),
		pvcUid: nullableStringField(value, "pvcUid", "provider response.kubernetes"),
	};
}

function parseErrorResponse(value: Record<string, unknown>): ProviderErrorResponse {
	const error = value["error"];
	if (!isPlainRecord(error)) {
		throw ProviderProtocolError.invalidRequest("provider response: error must be an object");
	}
	rejectUnknownKeys(error, PROVIDER_ERROR_OBJECT_KEYS, "provider response.error");
	const code = error["code"];
	if (typeof code !== "string" || !PROVIDER_ERROR_CODES.includes(code as ProviderErrorCode)) {
		throw ProviderProtocolError.invalidRequest(
			`provider response: error.code must be one of ${PROVIDER_ERROR_CODES.join("|")}`,
		);
	}
	const retryable = error["retryable"];
	if (typeof retryable !== "boolean") {
		throw ProviderProtocolError.invalidRequest(
			"provider response: error.retryable must be a boolean",
		);
	}
	return {
		ok: false,
		providerProto: OMP_PROVIDER_PROTO,
		error: {
			code: code as ProviderErrorCode,
			message: requireStringField(error, "message", "provider response.error"),
			retryable,
		},
	};
}

/**
 * Parse an untrusted response payload: byte-bound (1 MiB by default), JSON
 * parse, then strict envelope validation per the `ok` branch (unknown keys
 * rejected). An `ok:false` envelope parses and returns as-is — the caller
 * decides how to surface provider-typed failures. A provider-authored
 * malformed envelope throws ProviderProtocolError("invalid_request").
 */
export function parseProviderResponse(
	raw: string,
	opts?: ValidateProviderOptions,
): ProviderResponse {
	const maxBytes = opts?.maxBytes ?? PROVIDER_JSON_MAX_BYTES;
	const value = parseWithByteBound(raw, maxBytes, "provider response");
	if (!isPlainRecord(value)) {
		throw ProviderProtocolError.invalidRequest("provider response: expected an object");
	}
	if (value["providerProto"] !== OMP_PROVIDER_PROTO) {
		throw ProviderProtocolError.invalidRequest(
			`provider response: providerProto must be ${OMP_PROVIDER_PROTO}, got ${JSON.stringify(value["providerProto"])}`,
		);
	}
	rejectUnknownKeys(
		value,
		value["ok"] === true ? PROVIDER_OK_KEYS : PROVIDER_ERROR_KEYS,
		"provider response",
	);
	if (value["ok"] === true) return parseOkResponse(value);
	if (value["ok"] === false) return parseErrorResponse(value);
	throw ProviderProtocolError.invalidRequest("provider response: ok must be true or false");
}

// ---------------------------------------------------------------------------
// Identity helpers (stop-proof, PID-reuse-rejecting)
// ---------------------------------------------------------------------------

/**
 * Read `/proc/<pid>/stat` field 22 (starttime, clock ticks since boot).
 * Returns null when the pid is not a live process or the file is unreadable
 * (the correct "gone" answer). `comm` may contain spaces or `)` — the tail
 * after the LAST `) ` is parsed, keeping the field indexes stable.
 */
export function parseProcStartTime(pid: number): number | null {
	if (!Number.isSafeInteger(pid) || pid < 1) return null;
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch {
		return null;
	}
	const close = stat.lastIndexOf(") ");
	if (close < 0) return null;
	const tail = stat.slice(close + 2).split(" ");
	// Field 22 is starttime: 22 - 3 = 19th element of the tail (fields 3..n).
	const start = Number(tail[19]);
	return Number.isFinite(start) ? start : null;
}

/**
 * Read the provider's identity pidfile from its private per-workspace
 * `stateDir`. Returns null when absent or malformed. Unknown extra fields
 * are tolerated — the file is provider-private and forward-compatible.
 */
export function readProviderPidFile(stateDir: string): ProviderPidFile | null {
	let raw: string;
	try {
		raw = readFileSync(join(stateDir, PROVIDER_PID_FILE), "utf8");
	} catch {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		return null;
	}
	if (!isPlainRecord(value)) return null;
	const pid = value["pid"];
	const procStartTime = value["procStartTime"];
	const generation = value["generation"];
	const workspaceToken = value["workspaceToken"];
	if (
		typeof pid !== "number" ||
		!Number.isSafeInteger(pid) ||
		pid < 1 ||
		typeof procStartTime !== "number" ||
		!Number.isFinite(procStartTime) ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation < 1 ||
		typeof workspaceToken !== "string" ||
		workspaceToken.length === 0 ||
		workspaceToken.length > 4096
	) {
		return null;
	}
	return { pid, procStartTime, generation, workspaceToken };
}

/**
 * Identity check for stop-proof: the workspace's launch identity is
 * (pid, procStartTime) plus the launch token in argv. True only when the
 * pidfile exists, a live process at that pid has the same procStartTime (a
 * reused PID with a different start time never matches), and
 * `/proc/<pid>/cmdline` still contains the recorded workspaceToken. A
 * missing pidfile or gone process returns false ("terminated or unknown —
 * cannot claim live"). Never PID-only.
 */
export function matchProviderPidFile(stateDir: string, pid: number): boolean {
	const record = readProviderPidFile(stateDir);
	if (record === null) return false;
	const live = parseProcStartTime(pid);
	if (live === null || live !== record.procStartTime) return false;
	let cmdline: string;
	try {
		cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
	} catch {
		return false;
	}
	return cmdline.includes(record.workspaceToken);
}
