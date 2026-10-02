/**
 * Sandbox baseline config seeding (bwrap fleet clones).
 *
 * Managed clone sandboxes boot with `HOME=<volume>/.home` and
 * `PI_CODING_AGENT_DIR=<volume>/.home/agent`, so they never see the
 * operator's `~/.omp/agent/config.yml` and every fresh clone would boot at
 * SDK defaults. prepareWorkspace calls seedSandboxBaseline at prepare time
 * to copy a sanitized subset of the operator's global config into the
 * volume's `.home/agent/config.yml` (fleet-side, bwrap only; k8s prepares
 * in-pod and stays unseeded for v1).
 *
 * The copy is allowlisted, not denylisted, because the SDK config schema
 * holds ~444 keys with no host-boundness annotation, and a denylist would
 * have to be exhaustive to be safe. Only keys under
 * SANDBOX_BASELINE_ALLOWLIST cross the boundary, so credentials the SDK
 * marks `isCredential` (auth.broker.token, mnemopi.*ApiKey,
 * hindsight.apiToken, searxng.*, dev.autoqaPush.token) can never pass:
 * none of those paths are allowlisted. The string shape filter below is
 * the belt-and-suspenders guard that keeps host-bound paths and URLs out
 * (`~/...`, `/abs`, `https?://...`) even under an allowlisted key.
 *
 * The same seed also writes a sanitized `models.yml` beside `config.yml`:
 * custom provider definitions (the operator's `~/.omp/agent/models.yml`)
 * never cross into the sandbox otherwise, so the injected profile secretRefs
 * keys would bind to nothing and the model picker would come up empty.
 * Sanitization keeps env references verbatim (a value whose name is present
 * in the seed env) and rewrites literal provider `apiKey` secrets to the
 * `PROVIDER_ID_UPPER_SNAKE_API_KEY` convention so the sandbox can bind them
 * to injected keys, but literal secrets are never copied, `!cmd` host shell
 * commands and `transport: "pi-native"` providers (host-bound auth-gateway
 * bearer) are dropped, and headers only survive as env references. The
 * config copy's `modelRoles` and `cycleOrder` are then filtered to
 * providers that actually resolve given the env keys the sandbox carries.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { YAML } from "bun";

/**
 * Dot-path prefixes of SDK config keys safe to copy into a managed sandbox.
 * A key is kept when it equals one of these prefixes or sits beneath one;
 * a key that only sits above a prefix (e.g. `model` over
 * `model.loopGuard`) is recursed into so its allowlisted descendants can
 * be kept. Everything else (credentials, host-bound service endpoints,
 * UI-only settings, update checks) is dropped.
 */
export const SANDBOX_BASELINE_ALLOWLIST = [
	"modelRoles",
	"enabledModels",
	"disabledProviders",
	"modelTags",
	"modelProviderOrder",
	"cycleOrder",
	"personality",
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"repetitionPenalty",
	"textVerbosity",
	"defaultThinkingLevel",
	"thinkingBudgets",
	"tier",
	"model.loopGuard",
	"model.toolCallLoopGuard",
	"retry",
	"includeModelInPrompt",
	"includeWorkspaceTree",
	"inlineToolDescriptors",
	"compaction",
	"contextPromotion",
	"branchSummary",
	"tools.approval",
	"tools.approvalMode",
	"bash.patterns",
	"bashInterceptor",
	"task.maxConcurrency",
	"task.eager",
	"task.isolation.mode",
	"plan.defaultOnStartup",
	"steeringMode",
	"followUpMode",
	"interruptMode",
	"magicKeywords",
	"memory.backend",
	"ttsr",
] as const satisfies readonly string[];

/**
 * Service-gated compaction keys dropped even though they sit under the
 * allowlisted `compaction` prefix: a clone's isolated netns cannot reach
 * the operator's compaction service endpoints.
 */
const COMPACTION_REMOTE_DENY = [
	"compaction.remoteEnabled",
	"compaction.remoteEndpoint",
	"compaction.remoteStreamingV2Enabled",
] as const;

/** First line of the seeded config file; explains the file to a booted sandbox. */
const SEED_COMMENT =
	"# Seeded from the operator's global config by omp-web (allowlisted agent-behavior keys only).\n";

/** First line of the seeded models.yml; explains the file to a booted sandbox. */
const MODELS_SEED_COMMENT =
	"# Seeded from the operator's global models.yml by omp-web (env references only, no literal secrets).\n";

const HOST_BOUND_VALUE = /^~(\/|$)|^\//;
const HOST_BOUND_URL = /^https?:\/\//i;

/** Result of a sandbox-baseline seed attempt (never throws). */
export interface BaselineSeedResult {
	seeded: boolean;
	/** Absolute source path, when one was found. */
	source?: string;
	/** Why nothing was seeded: "no-source" | "unparseable" | "empty-after-filter" | "exists" | "unwritable". */
	reason?: string;
	/** Whether a sibling models.yml was seeded into the sandbox agent dir. */
	modelsSeeded?: boolean;
	/**
	 * Why the models.yml seed was skipped or failed: "no-source" |
	 * "unparseable" | "empty-after-filter" | "exists" | "unwritable".
	 */
	modelsReason?: string;
	/**
	 * Env var names the seeded models.yml references: kept env references plus
	 * generated `PROVIDER_ID_UPPER_SNAKE_API_KEY` convention rewrites. Sorted,
	 * deduped. Only set when the models.yml seed wrote a file this run.
	 */
	requiredEnvKeys?: string[];
}

/** A credential-bearing leaf key whose value must never cross as a literal. */
const CREDENTIAL_LEAF_KEY: Record<string, true> = {
	apikey: true,
	api_key: true,
	token: true,
	secret: true,
	password: true,
	authorization: true,
};

/** Identifiers that can reference an env var by name. */
const ENV_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Convert a provider id to the conventional injected env var name:
 * `tokenrouter` → `TOKENROUTER_API_KEY`, non-alphanumeric runs become `_`.
 */
export function providerEnvKeyName(providerId: string): string {
	return `${providerId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}_API_KEY`;
}

/** Result of a models.yml sanitization (pure). */
export interface ModelsSanitizeResult {
	config: Record<string, unknown>;
	/** Sorted, deduped env var names the sanitized document references. */
	requiredEnvKeys: string[];
}

/** True when `value` is an env reference whose name is present in `env`. */
function isEnvReference(value: unknown, env: Record<string, string | undefined>): value is string {
	if (typeof value !== "string" || !ENV_IDENTIFIER.test(value)) return false;
	return Object.prototype.hasOwnProperty.call(env, value);
}

/**
 * Sanitize a parsed models.yml document so it is safe to seed into a managed
 * sandbox. Pure: walks the plain-object tree, keeping provider definitions
 * whose credentials resolve through the injected env, never copying literal
 * secrets, and recording every env var the output references. Non-plain
 * input yields `{}`. Never throws.
 */
export function sanitizeModelsConfig(
	raw: unknown,
	env: Record<string, string | undefined>,
): ModelsSanitizeResult {
	const requiredEnvKeys = new Set<string>();
	if (!isPlainObject(raw)) return { config: {}, requiredEnvKeys: [] };

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const filtered = sanitizeModelsNode(key, value, env, requiredEnvKeys);
		if (filtered !== undefined) out[key] = filtered;
	}
	return { config: out, requiredEnvKeys: [...requiredEnvKeys].sort() };
}

/**
 * Recursively sanitize one models.yml node. Undefined means "prune this
 * key": unsafe value (literal credential secret, `!cmd` host command) or an
 * emptied container. Literal `providers.<id>.apiKey` secrets are rewritten
 * by {@link sanitizeProvider}, which has the provider id for the convention
 * env name.
 */
function sanitizeModelsNode(
	key: string,
	value: unknown,
	env: Record<string, string | undefined>,
	requiredEnvKeys: Set<string>,
): unknown {
	// Credential leaves are recognized case-insensitively. Values starting
	// with `!` run host shell commands at resolution time (SDK
	// resolveConfigValue) and never cross.
	if (CREDENTIAL_LEAF_KEY[key.toLowerCase()] === true) {
		if (typeof value === "string" && value.startsWith("!")) return undefined;
		if (isEnvReference(value, env)) {
			requiredEnvKeys.add(value);
			return value;
		}
		// A literal credential leaf (of any type) anywhere other than the
		// direct `providers.<id>.apiKey` slot is dropped, never copied.
		return undefined;
	}

	// Headers maps: values survive only as env references, regardless of the
	// header name. Secret-named and innocuous-named headers both drop literal
	// values; the kept header value is recorded (its env var).
	if (key === "headers" && isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [headerName, headerValue] of Object.entries(value)) {
			if (!isEnvReference(headerValue, env)) continue;
			requiredEnvKeys.add(headerValue);
			out[headerName] = headerValue;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}

	// `providers.<id>` objects: whole-provider rules apply (pi-native drop,
	// apiKey literal rewrite), then recurse into fields.
	if (key === "providers" && isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [providerId, providerValue] of Object.entries(value)) {
			if (!isPlainObject(providerValue)) continue;
			if (providerValue.transport === "pi-native") continue;
			const filtered = sanitizeProvider(providerId, providerValue, env, requiredEnvKeys);
			if (filtered !== undefined && Object.keys(filtered).length > 0) out[providerId] = filtered;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}

	// Plain containers recurse.
	if (isPlainObject(value)) {
		const out: Record<string, unknown> = {};
		for (const [subKey, subValue] of Object.entries(value)) {
			const filtered = sanitizeModelsNode(subKey, subValue, env, requiredEnvKeys);
			if (filtered !== undefined) out[subKey] = filtered;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}

	// Arrays (e.g. `models` model definitions) recurse per element so nested
	// containers such as model-level `headers` are scrubbed the same way.
	if (Array.isArray(value)) {
		const kept: unknown[] = [];
		for (const element of value) {
			const filtered = isPlainObject(element)
				? sanitizeModelsNode("", element, env, requiredEnvKeys)
				: element;
			if (filtered !== undefined) kept.push(filtered);
		}
		return kept.length > 0 ? kept : undefined;
	}

	// Scalars (booleans, numbers, non-credential strings such as baseUrl URLs,
	// api names, discovery types) survive untouched.
	return value;
}

/** Filter one provider object at `providers.<id>`. */
function sanitizeProvider(
	providerId: string,
	provider: Record<string, unknown>,
	env: Record<string, string | undefined>,
	requiredEnvKeys: Set<string>,
): Record<string, unknown> | undefined {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(provider)) {
		if (CREDENTIAL_LEAF_KEY[key.toLowerCase()] !== true) {
			const filtered = sanitizeModelsNode(key, value, env, requiredEnvKeys);
			if (filtered !== undefined) out[key] = filtered;
			continue;
		}
		if (isEnvReference(value, env)) {
			// Env reference present in the operator env: kept verbatim.
			requiredEnvKeys.add(value as string);
			out[key] = value;
		} else if (key === "apiKey") {
			// Any other apiKey form (literal secret, `!` host command,
			// malformed non-string) is rewritten to the convention env name:
			// the secret never crosses, and the provider becomes resolvable
			// exactly when the profile's secretRefs inject that name.
			const rewritten = providerEnvKeyName(providerId);
			out[key] = rewritten;
			requiredEnvKeys.add(rewritten);
		}
		// Other literal credential leaves (token/secret/password/...) drop.
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Providers a booted sandbox can actually resolve to a credential, given the
 * env names the sandbox will carry. OAuth providers need host-bound tokens
 * and never resolve in a sandbox. `auth: "apiKey"` resolves only when the
 * post-sanitize apiKey (an env name) is carried; an absent credential with
 * no auth declared is an open endpoint and resolves.
 */
function resolvableModelsProviders(
	sanitized: Record<string, unknown>,
	sandboxEnvKeys: ReadonlySet<string>,
	brokerEnabled: boolean,
): Set<string> {
	const resolvable = new Set<string>();
	const providers = sanitized.providers;
	if (!isPlainObject(providers)) return resolvable;
	for (const [providerId, providerValue] of Object.entries(providers)) {
		if (!isPlainObject(providerValue)) continue;
		// OAuth credentials live in the host agent.db and never cross as
		// files; they resolve only when the sandbox borrows them from an
		// auth broker (OMP_AUTH_BROKER_URL/TOKEN injected).
		if (providerValue.auth === "oauth") {
			if (brokerEnabled) resolvable.add(providerId);
			continue;
		}
		if (providerValue.auth === "none") {
			resolvable.add(providerId);
			continue;
		}
		const apiKey = providerValue.apiKey;
		const authHeader = providerValue.authHeader;
		if (typeof apiKey === "string" && sandboxEnvKeys.has(apiKey)) {
			resolvable.add(providerId);
			continue;
		}
		if (apiKey === undefined && authHeader === undefined && providerValue.auth === undefined) {
			resolvable.add(providerId);
		}
	}
	return resolvable;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function isHostBoundString(value: unknown): boolean {
	if (typeof value !== "string") return false;
	return HOST_BOUND_VALUE.test(value) || HOST_BOUND_URL.test(value);
}

/** A dot-path sits at or beneath one of the denied compaction keys. */
function isCompactionRemoteDenied(dotPath: string): boolean {
	return COMPACTION_REMOTE_DENY.some(
		(prefix) => dotPath === prefix || dotPath.startsWith(`${prefix}.`),
	);
}

/**
 * Filter an operator global config (parsed YAML) to sandbox-safe keys.
 * Pure: walks the plain-object tree once, keeping allowlisted subtrees
 * (less the compaction remote keys), dropping host-bound string values,
 * and pruning keys that filter to nothing. Non-plain-object input yields
 * `{}`.
 */
export function sanitizeBaselineConfig(raw: unknown): Record<string, unknown> {
	if (!isPlainObject(raw)) return {};
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const filtered = sanitizeNode(key, value);
		if (filtered !== undefined) out[key] = filtered;
	}
	return out;
}

/** How a dot-path relates to the allowlist: below it, above it, or unrelated. */
type Relation = "keep" | "recurse" | "drop";

function relationOf(dotPath: string): Relation {
	if (isCompactionRemoteDenied(dotPath)) return "drop";
	if (SANDBOX_BASELINE_ALLOWLIST.some((p) => dotPath === p || dotPath.startsWith(`${p}.`))) {
		return "keep";
	}
	if (SANDBOX_BASELINE_ALLOWLIST.some((p) => p.startsWith(`${dotPath}.`))) return "recurse";
	return "drop";
}

/**
 * Filter one node at `dotPath`. Undefined means "prune this key": the
 * node is unrelated to the allowlist, its filtered value vanished, or it
 * was an ancestor-shaped key whose value was not a plain object.
 */
function sanitizeNode(dotPath: string, value: unknown): unknown {
	const relation = relationOf(dotPath);
	if (relation === "drop") return undefined;
	if (relation === "recurse") {
		if (!isPlainObject(value)) return undefined;
		const out: Record<string, unknown> = {};
		for (const [key, sub] of Object.entries(value)) {
			const filtered = sanitizeNode(`${dotPath}.${key}`, sub);
			if (filtered !== undefined) out[key] = filtered;
		}
		return Object.keys(out).length > 0 ? out : undefined;
	}
	return sanitizeKeptNode(dotPath, value);
}

/**
 * Filter the value of a kept (allowlisted) dot-path. Descendants stay
 * allowlisted, so only the compaction sub-deny and the shape filter apply
 * from here down. Empty objects and arrays emptied by the filter prune.
 */
function sanitizeKeptNode(dotPath: string, value: unknown): unknown {
	if (Array.isArray(value)) {
		const kept: unknown[] = [];
		let droppedAny = false;
		for (const element of value) {
			if (isHostBoundString(element)) {
				droppedAny = true;
				continue;
			}
			kept.push(element);
		}
		if (kept.length === 0 && droppedAny) return undefined;
		return kept;
	}
	if (!isPlainObject(value)) return isHostBoundString(value) ? undefined : value;
	const out: Record<string, unknown> = {};
	for (const [key, sub] of Object.entries(value)) {
		if (isCompactionRemoteDenied(`${dotPath}.${key}`)) continue;
		const filtered = sanitizeKeptNode(`${dotPath}.${key}`, sub);
		if (filtered !== undefined) out[key] = filtered;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Locate the operator's global config file, or null.
 *
 * `OMP_SANDBOX_BASELINE_CONFIG` wins when set (explicitly; a missing or
 * unreadable override resolves to null with no fallthrough). Otherwise the
 * first existing `config.yml` or `config.yaml` under `$PI_CODING_AGENT_DIR`,
 * then `$XDG_DATA_HOME/omp/agent`, then `~/.omp/agent` (the operator home
 * from `env.HOME`, mirroring the agent-dir convention in fleet/stats).
 * `HOME` unset means the home location is skipped; the function only ever
 * consults the env record handed to it.
 */
export function resolveBaselineSourcePath(env: Record<string, string | undefined>): string | null {
	const override = env.OMP_SANDBOX_BASELINE_CONFIG;
	if (override !== undefined && override !== "") {
		return existsSync(override) ? override : null;
	}

	const candidates: string[] = [];
	const agentDir = env.PI_CODING_AGENT_DIR;
	if (agentDir !== undefined && agentDir !== "") {
		candidates.push(join(agentDir, "config.yml"), join(agentDir, "config.yaml"));
	}
	const xdgDataHome = env.XDG_DATA_HOME;
	if (xdgDataHome !== undefined && xdgDataHome !== "") {
		const xdgAgentDir = join(xdgDataHome, "omp", "agent");
		candidates.push(join(xdgAgentDir, "config.yml"), join(xdgAgentDir, "config.yaml"));
	}
	const home = env.HOME;
	if (home !== undefined && home !== "") {
		const homeAgentDir = join(home, ".omp", "agent");
		candidates.push(join(homeAgentDir, "config.yml"), join(homeAgentDir, "config.yaml"));
	}
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Candidate `models.yml`/`models.yaml` source file pairs beside a config source. */
const MODELS_BASELINE_FILENAMES = ["models.yml", "models.yaml"] as const;

/**
 * Resolve the models.yml source that sits beside a pinned config source:
 * `models.yml` then `models.yaml` in the same directory. Returns null when
 * neither exists.
 */
function resolveModelsBesideConfig(configSource: string): string | null {
	const dir = dirname(configSource);
	return (
		MODELS_BASELINE_FILENAMES.map((name) => join(dir, name)).find((candidate) =>
			existsSync(candidate),
		) ?? null
	);
}

/**
 * Resolve a models.yml source with the same precedence as
 * {@link resolveBaselineSourcePath}: `models.yml` then `models.yaml` under
 * `$PI_CODING_AGENT_DIR`, then `$XDG_DATA_HOME/omp/agent`, then
 * `~/.omp/agent`. Returns null when none exists.
 */
function resolveModelsSourcePath(env: Record<string, string | undefined>): string | null {
	const candidates: string[] = [];
	const agentDir = env.PI_CODING_AGENT_DIR;
	if (agentDir !== undefined && agentDir !== "") {
		candidates.push(join(agentDir, "models.yml"), join(agentDir, "models.yaml"));
	}
	const xdgDataHome = env.XDG_DATA_HOME;
	if (xdgDataHome !== undefined && xdgDataHome !== "") {
		const xdgAgentDir = join(xdgDataHome, "omp", "agent");
		candidates.push(join(xdgAgentDir, "models.yml"), join(xdgAgentDir, "models.yaml"));
	}
	const home = env.HOME;
	if (home !== undefined && home !== "") {
		const homeAgentDir = join(home, ".omp", "agent");
		candidates.push(join(homeAgentDir, "models.yml"), join(homeAgentDir, "models.yaml"));
	}
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Resolve the effective env record for a seed attempt. */
function baselineEnv(
	options: { env?: Record<string, string | undefined> } | undefined,
): Record<string, string | undefined> {
	return options?.env ?? (process.env as Record<string, string | undefined>);
}

/** Env names that switch a sandboxed daemon into auth-broker mode. Both must be present (URL without token is a boot error in the SDK, not a fallback). */
const BROKER_ENV_KEYS = ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"] as const;

interface CatalogEnvInfo {
	/** Catalog provider id → env var names that can credential it directly. */
	readonly envVarsById: ReadonlyMap<string, readonly string[]>;
	/** Every catalog provider id (broker mode credentials any of them). */
	readonly allIds: readonly string[];
}

/**
 * Resolvable providers for the role filter, given the sanitized models.yml
 * and the env names the sandbox carries. Custom providers (from the
 * sanitized models.yml) resolve per {@link resolvableModelsProviders};
 * catalog providers resolve when ANY of their catalog env vars is among
 * the carried keys, or unconditionally when the sandbox borrows
 * credentials from an auth broker. `catalog` is undefined when the lazy
 * catalog import failed, in which case catalog providers never resolve.
 */
function resolvableProvidersForRoles(
	sanitizedModels: Record<string, unknown>,
	sandboxEnvKeys: ReadonlySet<string>,
	catalog: CatalogEnvInfo | undefined,
): Set<string> {
	const brokerEnabled = BROKER_ENV_KEYS.every((name) => sandboxEnvKeys.has(name));
	const resolvable = resolvableModelsProviders(sanitizedModels, sandboxEnvKeys, brokerEnabled);
	if (catalog !== undefined) {
		if (brokerEnabled) {
			for (const providerId of catalog.allIds) resolvable.add(providerId);
		} else {
			for (const [providerId, envNames] of catalog.envVarsById) {
				if (envNames.some((name) => sandboxEnvKeys.has(name))) resolvable.add(providerId);
			}
		}
	}
	return resolvable;
}

/**
 * Lazily load the SDK provider catalog's env-var table (provider id → the
 * env var names that can credential it; multi-var providers like
 * moonshot's [MOONSHOT_API_KEY, KIMI_API_KEY] keep every alias) plus the
 * full id list for broker mode. Returns undefined when the catalog is not
 * importable (the role filter then degrades to custom providers only).
 */
async function loadCatalogEnvInfo(): Promise<CatalogEnvInfo | undefined> {
	try {
		// Exception: lazy import is deliberate here to keep the static module
		// graph SDK-free (fleet/omp-check.ts precedent); the catalog only
		// matters when a role filter actually runs. SDK 18 replaced the old
		// `CATALOG_PROVIDERS` array with `providerEntries()`, which lives behind
		// the package's `compat/providers` subpath (the root entry does not
		// re-export it and carries no env-var table).
		const { providerEntries } = await import("@oh-my-pi/pi-catalog/compat/providers");
		const envVarsById = new Map<string, readonly string[]>();
		const allIds: string[] = [];
		for (const provider of Object.values(providerEntries())) {
			allIds.push(provider.id);
			if (provider.envVars !== undefined && provider.envVars.length > 0) {
				envVarsById.set(provider.id, provider.envVars);
			}
		}
		return { envVarsById, allIds };
	} catch {
		return undefined;
	}
}

/**
 * Apply the role coherence filter to a sanitized config object. Drops
 * `modelRoles` entries and `cycleOrder` members whose provider prefix is not
 * in the resolvable set. Mutates and returns `config`.
 */
function applyRoleCoherenceFilter(
	config: Record<string, unknown>,
	resolvable: ReadonlySet<string>,
): void {
	const modelRoles = config.modelRoles;
	if (isPlainObject(modelRoles)) {
		const kept: Record<string, unknown> = {};
		for (const [role, modelId] of Object.entries(modelRoles)) {
			if (typeof modelId !== "string") continue;
			const slash = modelId.indexOf("/");
			if (slash === -1) continue; // no provider prefix: drop the entry
			const providerId = modelId.slice(0, slash);
			if (resolvable.has(providerId)) kept[role] = modelId;
		}
		if (Object.keys(kept).length > 0) config.modelRoles = kept;
		else delete config.modelRoles;
	}

	const cycleOrder = config.cycleOrder;
	if (Array.isArray(cycleOrder)) {
		const keptRoleNames = isPlainObject(config.modelRoles) ? Object.keys(config.modelRoles) : [];
		const kept: unknown[] = [];
		for (const entry of cycleOrder) {
			if (typeof entry !== "string") continue;
			if (entry.includes("/")) {
				// Model-id entry: the provider prefix must resolve.
				const providerId = entry.slice(0, entry.indexOf("/"));
				if (resolvable.has(providerId)) kept.push(entry);
			} else if (keptRoleNames.includes(entry)) {
				// Role-name entry: the role must survive the modelRoles filter.
				kept.push(entry);
			}
		}
		if (kept.length > 0) config.cycleOrder = kept;
		else delete config.cycleOrder;
	}
}

/** Outcome of reading + parsing a baseline source file. */
interface ParsedBaselineSource {
	ok: boolean;
	/** The parsed document; null for a blank/comment-only file or failure. */
	value: unknown;
}

/**
 * Read and parse a baseline source file (config.yml or models.yml). A
 * malformed or unreadable file yields `{ ok: false }`; a blank or
 * comment-only file parses successfully to null.
 */
function parseBaselineSource(sourcePath: string): ParsedBaselineSource {
	try {
		return { ok: true, value: YAML.parse(readFileSync(sourcePath, "utf8")) };
	} catch {
		return { ok: false, value: null };
	}
}

/**
 * Best-effort seed of `<volumeRoot>/.home/agent/config.yml` and its sibling
 * `<volumeRoot>/.home/agent/models.yml`. NEVER throws and NEVER overwrites an
 * existing target file. `options.sourcePath` wins over env resolution; an
 * explicit but missing sourcePath reports "no-source". The config seed is
 * the sanitized operator config (roles filtered to providers the sandbox can
 * resolve when `options.sandboxEnvKeys` is given) with a one-line provenance
 * comment; the models seed is the sanitized operator models.yml (env
 * references only) with its own provenance comment. The two files seed
 * independently: a pre-existing config target returns `reason: "exists"`
 * while the models.yml seed still runs, so volumes seeded before this
 * feature gained a models.yml on their next prepare.
 */
export async function seedSandboxBaseline(
	volumeRoot: string,
	options?: {
		env?: Record<string, string | undefined>;
		sourcePath?: string;
		sandboxEnvKeys?: readonly string[];
	},
): Promise<BaselineSeedResult> {
	const env = baselineEnv(options);
	const sandboxEnvKeys =
		options?.sandboxEnvKeys !== undefined ? new Set(options.sandboxEnvKeys) : undefined;
	const agentDirTarget = join(volumeRoot, ".home", "agent");
	const configTarget = join(agentDirTarget, "config.yml");
	const modelsTarget = join(agentDirTarget, "models.yml");
	const result: BaselineSeedResult = { seeded: false };

	// The pinned config source: explicit `options.sourcePath`, else the env
	// override, else null (env resolution happens per step so the models step
	// can still find a sibling when the config step resolved by env).
	const explicitSource =
		options?.sourcePath !== undefined && options.sourcePath !== "" && existsSync(options.sourcePath)
			? options.sourcePath
			: null;
	const envOverrideSource =
		explicitSource === null &&
		env.OMP_SANDBOX_BASELINE_CONFIG !== undefined &&
		env.OMP_SANDBOX_BASELINE_CONFIG !== "" &&
		existsSync(env.OMP_SANDBOX_BASELINE_CONFIG)
			? env.OMP_SANDBOX_BASELINE_CONFIG
			: null;

	// ── config.yml seed step ────────────────────────────────────────────────
	// Returns the config source that was used or would have been used.
	let configSource: string | null = explicitSource ?? resolveBaselineSourcePath(env);
	if (existsSync(configTarget)) {
		result.seeded = false;
		result.reason = "exists";
		// A pre-existing config target must not clobber user edits; keep
		// configSource null so the models step falls back to env resolution.
		configSource = null;
	} else if (configSource === null) {
		result.seeded = false;
		result.reason = "no-source";
	} else {
		const parsed = parseBaselineSource(configSource);
		if (!parsed.ok) {
			result.seeded = false;
			result.reason = "unparseable";
			configSource = null;
		} else {
			const sanitized = sanitizeBaselineConfig(parsed.value);
			let configEmpty = Object.keys(sanitized).length === 0;
			if (!configEmpty && sandboxEnvKeys !== undefined) {
				// Resolve the sibling models.yml so the filter knows which
				// custom providers resolve. A pinned config source looks for
				// models.yml/models.yaml beside itself only; an agent-dir
				// resolved config uses the same candidate dirs and precedence
				// as the config source. A missing or unparseable sibling
				// means no custom providers resolve; catalog providers whose
				// env key is carried still count.
				const roleModelsSource =
					explicitSource !== null
						? resolveModelsBesideConfig(explicitSource)
						: envOverrideSource !== null
							? resolveModelsBesideConfig(envOverrideSource)
							: resolveModelsSourcePath(env);
				const roleModelsParsed =
					roleModelsSource !== null ? parseBaselineSource(roleModelsSource) : null;
				const roleSanitized =
					roleModelsParsed !== null && roleModelsParsed.ok
						? sanitizeModelsConfig(roleModelsParsed.value, env)
						: null;
				const catalogEnvInfo = await loadCatalogEnvInfo();
				if (catalogEnvInfo !== undefined) {
					// The lazy catalog import succeeded: filter roles down to
					// the providers that resolve (custom per the sanitized
					// models.yml, catalog per the carried env names or the
					// injected auth broker).
					const resolvable = resolvableProvidersForRoles(
						roleSanitized?.config ?? {},
						sandboxEnvKeys,
						catalogEnvInfo,
					);
					applyRoleCoherenceFilter(sanitized, resolvable);
					configEmpty = Object.keys(sanitized).length === 0;
				}
				// The lazy SDK import failed: skip the entire role filter
				// (degrade to keep-everything per contract), so roles are
				// never wrongly dropped because the catalog was unavailable.
			}
			if (configEmpty) {
				result.seeded = false;
				result.reason = "empty-after-filter";
			} else {
				try {
					mkdirSync(dirname(configTarget), { recursive: true });
					writeFileSync(configTarget, SEED_COMMENT + YAML.stringify(sanitized), "utf8");
					result.seeded = true;
					result.source = configSource;
				} catch {
					result.seeded = false;
					result.reason = "unwritable";
				}
			}
		}
	}

	// ── models.yml seed step (independent of the config outcome) ────────────
	if (existsSync(modelsTarget)) {
		result.modelsReason = "exists";
	} else {
		// Sibling-models discovery mirrors the config source resolution: a
		// pinned config (explicit sourcePath or env override) only looks for
		// models.yml/models.yaml beside itself; an agent-dir resolved config
		// uses the same candidate dirs and precedence as the config source.
		// This holds even when the config target already exists, so volumes
		// seeded before this feature gain a models.yml on their next prepare.
		const siblingAnchor =
			explicitSource !== null
				? explicitSource
				: envOverrideSource !== null
					? envOverrideSource
					: null;
		const modelsSource =
			(siblingAnchor !== null ? resolveModelsBesideConfig(siblingAnchor) : null) ??
			(explicitSource === null && envOverrideSource === null ? resolveModelsSourcePath(env) : null);
		if (modelsSource === null) {
			result.modelsReason = "no-source";
		} else {
			const parsed = parseBaselineSource(modelsSource);
			if (!parsed.ok) {
				result.modelsReason = "unparseable";
			} else {
				const sanitizedModels = sanitizeModelsConfig(parsed.value, env);
				// Blank/comment-only YAML parses to null: an empty document is
				// empty-after-filter, never a seeded empty file.
				const rawEmpty = parsed.value === null;
				if (rawEmpty || Object.keys(sanitizedModels.config).length === 0) {
					result.modelsReason = "empty-after-filter";
				} else {
					try {
						mkdirSync(dirname(modelsTarget), { recursive: true });
						writeFileSync(
							modelsTarget,
							MODELS_SEED_COMMENT + YAML.stringify(sanitizedModels.config),
							"utf8",
						);
						result.modelsSeeded = true;
						result.requiredEnvKeys = sanitizedModels.requiredEnvKeys;
					} catch {
						result.modelsReason = "unwritable";
					}
				}
			}
		}
	}

	return result;
}
