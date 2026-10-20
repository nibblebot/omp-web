/**
 * Provider operation protocol (OMP_PROVIDER_PROTO = 1); the frozen contract
 * for fleet-side clone-workspace sandbox providers (P5.1). Encoding, request
 * shape, response shape, identity/supervision rules and the error vocabulary
 * are fixed here and supersede the earlier "Provider executable contract" draft.
 *
 * Invocation: the fleet runs `<executable> <op>` with exactly one JSON
 * request on stdin and exactly one JSON response on stdout; stderr is a
 * human log the fleet never parses. Exit 0 means a response was produced on
 * stdout; the response envelope itself carries the typed success or failure
 * (an `ok:false` envelope is a *successful* invocation whose operation
 * failed, classified by code, not by exit status). A non-zero exit with no
 * parseable response means the provider itself failed to operate.
 *
 * `preflight` is the one op that is not about a workspace: the provider
 * reports the environment checks it owns (binary/namespace/RBAC/...) for the
 * request's profile as `PreflightCheck[]`. The request shape is unchanged
 * (no per-op relaxation of the required fields); the fleet sends a fixed
 * placeholder identity built by `buildPreflightRequest` (workspaceId
 * "preflight", generation 1) and carries the fleet's workspace volume root in
 * `workspaceDir` (also used for `homeDir`/`stateDir`). A provider handles
 * preflight read-only: it never creates, writes, or removes anything at those
 * paths. The success envelope is `{ok:true, checks}` (no handle/observed);
 * `runProviderOp` rejects a lifecycle response to preflight and a preflight
 * response to any other op. No `OMP_PROVIDER_PROTO` bump: a provider that
 * predates the op rejects it as `invalid_request` (or exits non-zero), which
 * the fleet reports as a failing check, never as success.
 *
 * Safety rules enforced here (P5.5 never negotiable):
 * - No secrets travel in requests. Profiles reference secrets by name only
 *   (`secretRefs` values must be external secret references, never
 *   materialized values), and key allowlists reject unknown/extra fields at
 *   every nesting level so secret-shaped material cannot be smuggled in.
 * - All JSON I/O is size-bounded: requests and responses are capped at 1 MiB.
 * - State supervision is identity-based and provider-private. Each provider
 *   keeps whatever identity record it needs in its per-workspace `stateDir`
 *   (the fleet never reads it). Liveness and `stop` must prove the requested
 *   generation terminated, never by a reusable identifier (a bare pid, a
 *   resource name) alone.
 *
 * Pure module: no I/O, no process spawning. Spawning lives in
 * lib/runtime/provider-exec.ts.
 */

const utf8 = new TextEncoder();

/** Provider protocol version; the fleet pins it before invoking any provider. */
export const OMP_PROVIDER_PROTO = 1;

/** Serialized request/response cap: one JSON document per invocation (1 MiB). */
export const PROVIDER_JSON_MAX_BYTES = 1024 * 1024;

/** Operation kinds; the fleet invokes the executable with one of these. */
export const PROVIDER_OPS = [
	"ensure-running",
	"inspect",
	"stop",
	"delete",
	"list-sessions",
	"preflight",
] as const;
export type ProviderOp = (typeof PROVIDER_OPS)[number];

/**
 * One environment check a provider (or the fleet) reports. `remediation` is
 * present on failure when an operator action can fix it.
 */
export interface PreflightCheck {
	name: string;
	ok: boolean;
	/** Human detail: what was probed and what came back. */
	detail: string;
	/** Actionable fix, present on failure. */
	remediation?: string;
}

/** Lifecycle observation the provider reports for a workspace. */
export type ProviderObserved = "running" | "stopped" | "missing";

/**
 * Opaque, provider-namespaced handle: the provider's durable identity for the
 * resource it manages for this workspace. The fleet treats it as a private
 * opaque token; it never inspects it and it never crosses trust boundaries
 * (roster frames, /ctl/debug). Same workspace/generation → same handle; the
 * provider rediscoverable by durable identity, never by PID alone. Non-empty
 * and bounded; absent only until the provider has created the resource.
 */
export type ProviderHandle = string;

/**
 * Typed error vocabulary for provider operations, reusing the frozen ledger
 * vocabulary.
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
 * The provider kinds: the ONE source of truth for every validator and type
 * (protocol request, config load, preflight, wire). Adding a kind is one edit
 * here, its profile member below, its `PROVIDER_CAPABILITIES` row, and its
 * validator keys.
 */
export const PROVIDER_KINDS = ["bwrap", "kubernetes"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
	return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"`: the kinds list for error messages. */
export function describeProviderKinds(): string {
	const quoted = PROVIDER_KINDS.map((kind) => `"${kind}"`);
	return quoted.length <= 1
		? quoted.join("")
		: `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`;
}

/**
 * What a provider kind can do, answered by the fleet without exec'ing the
 * provider. Static per kind (not provider-reported): lifecycle decisions such
 * as clone preparation, wake resume and secret resolution must not require
 * spawning the provider executable.
 */
export interface ProviderCapabilities {
	/**
	 * Who prepares a NEW workspace volume: `"fleet"` clones at the pin and
	 * seeds the baseline on the fleet host before the provider runs;
	 * `"provider"` prepares it in place (e.g. a pod init step) from a source
	 * the provider can reach, so a fleet-host path is not a valid source.
	 */
	preparation: "fleet" | "provider";
	/** The workspace volume is readable at the same path on the fleet host (resume hint, transcript materialization, store-completeness checks). */
	volumeFleetVisible: boolean;
	/** `"fleet-env"`: `secretRefs` are `env:NAME` references the fleet resolves from its own environment; `"provider"`: references are resolved by the provider/cluster API-side. */
	secretResolution: "fleet-env" | "provider";
}

export const PROVIDER_CAPABILITIES: Record<ProviderKind, ProviderCapabilities> = {
	bwrap: { preparation: "fleet", volumeFleetVisible: true, secretResolution: "fleet-env" },
	kubernetes: { preparation: "provider", volumeFleetVisible: false, secretResolution: "provider" },
};

/**
 * In-pod workspace volume layout of a `kubernetes` runtime (the PVC is mounted
 * at `workspaceRoot`; the image entrypoint and the provider agree on it). The
 * fleet cannot read these paths: it uses `sessionsDir` only to recognize and
 * build the session-file paths a session reports (`lastSessionFile`) and the
 * wake resume hint handed back to it.
 */
export const KUBERNETES_POD_LAYOUT = {
	workspaceRoot: "/workspace",
	checkoutDir: "/workspace/.checkout",
	homeDir: "/workspace/.home",
	sessionsDir: "/workspace/.home/agent/sessions",
} as const;

/**
 * A provider profile: one `providerProfiles` entry of the fleet config file,
 * a union keyed on `provider`; per-kind fields live only on their member.
 * fleet/provider-profile.ts validates it and owns the config-file concern.
 * `secretRefs` holds external secret reference NAMES only; values never
 * leave the config file and never appear in requests.
 */
interface ProviderProfileBase {
	id: string;
	provider: ProviderKind;
	executable: string;
	resources?: { cpu?: string; memory?: string };
	storage?: { class?: string; size?: string };
	secretRefs?: Record<string, string>;
}

export interface BwrapProfile extends ProviderProfileBase {
	provider: "bwrap";
	/** Absolute tool paths ro-bound into the sandbox. */
	tools: string[];
	/** Sandbox network mode: "host" shares the host netns (dev profiles), "isolated" (default) keeps the fresh netns. */
	network?: "host" | "isolated";
}

export interface KubernetesProfile extends ProviderProfileBase {
	provider: "kubernetes";
	image?: string;
	namespace?: string;
	/** Operator-explicit kubeconfig context. The provider never falls back to
	 *  the ambient current-context (P5.3). */
	context?: string;
}

export type ProviderProfile = BwrapProfile | KubernetesProfile;

/** Request/config keys every kind shares. */
const PROFILE_BASE_KEYS = [
	"id",
	"provider",
	"executable",
	"resources",
	"storage",
	"secretRefs",
] as const;

/**
 * Per-kind profile key allowlist (base + the kind's own fields). A key owned
 * by another kind is a typed validation error, never silently carried.
 */
export const PROVIDER_PROFILE_KEYS: Record<ProviderKind, readonly string[]> = {
	bwrap: [...PROFILE_BASE_KEYS, "tools", "network"],
	kubernetes: [...PROFILE_BASE_KEYS, "image", "namespace", "context"],
};

/**
 * The kind that owns `key`, when it is a per-kind field of a kind other than
 * `kind` (null for base keys, own keys, and unknown keys).
 */
export function foreignProfileKeyOwner(kind: ProviderKind, key: string): ProviderKind | null {
	if (PROVIDER_PROFILE_KEYS[kind].includes(key)) return null;
	for (const other of PROVIDER_KINDS) {
		if (other !== kind && PROVIDER_PROFILE_KEYS[other].includes(key)) return other;
	}
	return null;
}

/** Fixed request field key set (steers `Object.keys` allowlist, see below). */
const PROVIDER_REQUEST_KEYS = [
	"op",
	"workspaceId",
	"generation",
	"workspaceDir",
	"homeDir",
	"profile",
	"handle",
	"stateDir",
	"source",
	"revision",
	"branch",
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
 * passphrase field; real secrets live behind the reference).
 */
const SECRET_REF_RE = /^[A-Za-z0-9._~:/@+-]+$/;

/** Handle bound: opaque tokens are bounded like the rest of the protocol. */
const HANDLE_MAX_BYTES = 4096;
/** Reference bound: external secret references are short names. */
const SECRET_REF_MAX_CHARS = 512;

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
	 * Clone source (exactly one member), additive for provider-side volume
	 * initialization (kubernetes in-pod PVC init); bwrap clones are prepared
	 * fleet-side and ignore it. `local` is a fleet-host filesystem path and is
	 * meaningless in-cluster; kubernetes providers reject it.
	 */
	source?: { local?: string; remote?: string };
	/** The pinned full commit (fleet-resolved once via resolveWorkspacePin). */
	revision?: string;
	/** The workspace branch created at the pin. */
	branch?: string;
}

/**
 * The `preflight` request for a profile: placeholder workspace identity, with
 * the fleet workspace volume root in `workspaceDir`/`homeDir`/`stateDir` (a
 * provider only reads it; see the header).
 */
export function buildPreflightRequest(
	profile: ProviderProfile,
	workspaceRoot: string,
): ProviderRequest & { op: "preflight" } {
	return {
		op: "preflight",
		workspaceId: "preflight",
		generation: 1,
		workspaceDir: workspaceRoot,
		homeDir: workspaceRoot,
		profile,
		stateDir: workspaceRoot,
	};
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
	const provider = value["provider"];
	if (!isProviderKind(provider)) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider request: ${where}.provider must be ${describeProviderKinds()}`,
		);
	}
	for (const key of Object.keys(value)) {
		const owner = foreignProfileKeyOwner(provider, key);
		if (owner !== null) {
			throw ProviderProtocolError.invalidRequest(
				`invalid provider request: ${where}.${key} is a ${owner} field and is not valid on a ${provider} profile`,
			);
		}
	}
	rejectUnknownKeys(value, PROVIDER_PROFILE_KEYS[provider], where);
	const secretRefsRaw = value["secretRefs"];
	let secretRefs: Record<string, string> | undefined;
	if (secretRefsRaw !== undefined) {
		if (!isPlainRecord(secretRefsRaw) || Object.keys(secretRefsRaw).length === 0) {
			throw ProviderProtocolError.invalidRequest(
				`invalid provider request: ${where}.secretRefs must be a non-empty object`,
			);
		}
		secretRefs = {};
		// Values are external secret reference names ONLY, never materialized
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
	const id = requireString(value, "id", where);
	const executable = requireString(value, "executable", where);
	const base = { id, executable, resources, storage, secretRefs };
	if (provider === "bwrap") {
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
			...base,
			provider,
			tools: toolsRaw as string[],
			...(networkRaw !== undefined ? { network: networkRaw as "host" | "isolated" } : {}),
		};
	}
	return {
		...base,
		provider,
		image: optionalString(value, "image", where),
		namespace: optionalString(value, "namespace", where),
		context: optionalString(value, "context", where, { maxChars: 512 }),
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
	const request: ProviderRequest = {
		op: op as ProviderOp,
		workspaceId: requireString(value, "workspaceId", "provider request"),
		generation,
		workspaceDir: requireString(value, "workspaceDir", "provider request"),
		homeDir: requireString(value, "homeDir", "provider request"),
		profile: parseProfile(value["profile"], "provider request.profile"),
		stateDir: requireString(value, "stateDir", "provider request"),
	};
	if (handle !== undefined) request.handle = handle;
	if (source !== undefined) request.source = source;
	const revision = optionalString(value, "revision", "provider request", { maxChars: 512 });
	if (revision !== undefined) request.revision = revision;
	const branch = optionalString(value, "branch", "provider request", { maxChars: 512 });
	if (branch !== undefined) request.branch = branch;
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
	"handle",
	"observed",
	"pid",
	"startedAt",
	"sessions",
	"complete",
] as const;
const PROVIDER_SESSION_FILE_KEYS = ["path", "size"] as const;
const PROVIDER_PREFLIGHT_OK_KEYS = ["ok", "checks"] as const;
const PREFLIGHT_CHECK_KEYS = ["name", "ok", "detail", "remediation"] as const;
const PROVIDER_ERROR_KEYS = ["ok", "error"] as const;
const PROVIDER_ERROR_OBJECT_KEYS = ["code", "message", "retryable"] as const;

/** Successful operation envelope. */
export interface ProviderOkResponse {
	ok: true;
	/** Opaque provider-namespaced handle; equals the request's handle when one was carried. */
	handle: ProviderHandle;
	/** Runtime observation; `running` implies a live resource for the current generation. */
	observed: ProviderObserved;
	/**
	 * Diagnostic only: a live process pid when the provider can name one (bwrap
	 * does; kubernetes does not). The fleet never keys state or decisions on it,
	 * and a pid alone is never proof of liveness or termination.
	 */
	pid?: number;
	/** Epoch ms when a live process was last (re)started. */
	startedAt?: number;
	/**
	 * `list-sessions` only: every session file on the workspace volume
	 * (regular files under the agent sessions dir, symlinks excluded).
	 */
	sessions?: ProviderSessionFile[];
	/**
	 * `list-sessions` only: true when `sessions` is the whole inventory.
	 * False means the volume exceeds the export bounds (file count, bytes,
	 * or response size) and `sessions` is a truncated prefix; the fleet
	 * refuses to treat a truncated inventory as proof of anything.
	 */
	complete?: boolean;
}

/**
 * One session file on a workspace volume, as a `list-sessions` response
 * reports it: `path` is relative to the agent sessions dir
 * (`<sessionId>/<file under the session>`, POSIX separators), `size` is the
 * byte length.
 */
export interface ProviderSessionFile {
	path: string;
	size: number;
}

/** Successful `preflight` envelope: the provider's environment checks. */
export interface ProviderPreflightResponse {
	ok: true;
	checks: PreflightCheck[];
}

/** Typed failure envelope: the invocation succeeded, the operation failed. */
export interface ProviderErrorResponse {
	ok: false;
	error: {
		code: ProviderErrorCode;
		message: string;
		/** True when retrying the same operation is a safe, likely-successful next step. */
		retryable: boolean;
	};
}

/** One provider operation response (frozen contract). */
export type ProviderResponse =
	| ProviderOkResponse
	| ProviderPreflightResponse
	| ProviderErrorResponse;

function requireStringField(value: Record<string, unknown>, field: string, where: string): string {
	const v = value[field];
	if (typeof v !== "string" || v.length === 0 || v.includes("\0")) {
		throw ProviderProtocolError.invalidRequest(
			`invalid provider response: ${where}.${field} must be a non-empty string`,
		);
	}
	return v;
}

function parseSessionFiles(value: unknown): ProviderSessionFile[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw ProviderProtocolError.invalidRequest("provider response: sessions must be an array");
	}
	return value.map((item, index) => {
		const where = `provider response.sessions[${index}]`;
		if (!isPlainRecord(item)) {
			throw ProviderProtocolError.invalidRequest(`${where}: expected an object`);
		}
		rejectUnknownKeys(item, PROVIDER_SESSION_FILE_KEYS, where);
		const size = item["size"];
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
			throw ProviderProtocolError.invalidRequest(
				`${where}.size must be a non-negative safe integer`,
			);
		}
		return { path: requireStringField(item, "path", where), size };
	});
}

function parseOkResponse(value: Record<string, unknown>): ProviderOkResponse {
	const observed = value["observed"];
	if (observed !== "running" && observed !== "stopped" && observed !== "missing") {
		throw ProviderProtocolError.invalidRequest(
			'provider response: observed must be "running", "stopped", or "missing"',
		);
	}
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
		handle: requireStringField(value, "handle", "provider response"),
		observed,
		pid,
		startedAt,
	};
	const sessions = parseSessionFiles(value["sessions"]);
	if (sessions !== undefined) response.sessions = sessions;
	const complete = value["complete"];
	if (complete !== undefined) {
		if (typeof complete !== "boolean") {
			throw ProviderProtocolError.invalidRequest("provider response: complete must be a boolean");
		}
		response.complete = complete;
	}
	return response;
}

function parsePreflightResponse(value: Record<string, unknown>): ProviderPreflightResponse {
	const raw = value["checks"];
	if (!Array.isArray(raw)) {
		throw ProviderProtocolError.invalidRequest("provider response: checks must be an array");
	}
	const checks = raw.map((entry, index): PreflightCheck => {
		const where = `provider response.checks[${index}]`;
		if (!isPlainRecord(entry)) {
			throw ProviderProtocolError.invalidRequest(`provider response: ${where} must be an object`);
		}
		rejectUnknownKeys(entry, PREFLIGHT_CHECK_KEYS, where);
		if (typeof entry["ok"] !== "boolean") {
			throw ProviderProtocolError.invalidRequest(
				`provider response: ${where}.ok must be a boolean`,
			);
		}
		const check: PreflightCheck = {
			name: requireStringField(entry, "name", where),
			ok: entry["ok"],
			detail: requireStringField(entry, "detail", where),
		};
		const remediation = entry["remediation"];
		if (remediation !== undefined) {
			if (
				typeof remediation !== "string" ||
				remediation.length === 0 ||
				remediation.includes("\0")
			) {
				throw ProviderProtocolError.invalidRequest(
					`provider response: ${where}.remediation must be a non-empty string`,
				);
			}
			check.remediation = remediation;
		}
		return check;
	});
	return { ok: true, checks };
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
 * rejected). An `ok:false` envelope parses and returns as-is; the caller
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
	const preflight = value["ok"] === true && "checks" in value;
	rejectUnknownKeys(
		value,
		value["ok"] === true
			? preflight
				? PROVIDER_PREFLIGHT_OK_KEYS
				: PROVIDER_OK_KEYS
			: PROVIDER_ERROR_KEYS,
		"provider response",
	);
	if (preflight) return parsePreflightResponse(value);
	if (value["ok"] === true) return parseOkResponse(value);
	if (value["ok"] === false) return parseErrorResponse(value);
	throw ProviderProtocolError.invalidRequest("provider response: ok must be true or false");
}
