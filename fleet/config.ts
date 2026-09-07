/**
 * Fleet configuration: spawn templates and the default template, loaded
 * from `~/.omp-web/config.json`.
 *
 * Resolution order: an explicit `path` argument wins, then env
 * `OMP_FLEET_CONFIG`, then the default location. A missing file yields
 * defaults; the file is shallow-merged over the defaults and unknown fields
 * are tolerated. `OMP_FLEET_SPAWN_HOOK` overrides the config file's
 * `spawnHook`; `OMP_FLEET_LOCAL_TEMPLATE` replaces the `local` template's
 * command outright (dev runners point it at the source entry when the
 * production binary isn't built). `workspaceDir` (root for managed
 * worktrees) resolves flag `--workspace-dir` > env `OMP_FLEET_WORKSPACE_DIR`
 * > config-file `workspaceDir` key > `~/.omp-web/workspaces`. The bind
 * address resolves `--bind` > env `OMP_FLEET_BIND` > config-file `bind` key
 * > `127.0.0.1`. The browser-auth operator token resolves
 * `--browser-access-token` > env `OMP_FLEET_BROWSER_TOKEN` > config-file
 * `browserAccessToken` (a pre-hashed 64-char sha-256 digest; the plaintext
 * is never stored). A leading `~` is expanded to `os.homedir()` in paths.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderProfile } from "./provider-profile";
import { validateProfiles } from "./provider-profile";
import { parseProxyRule } from "./trusted-proxy";

export interface SpawnTemplate {
	/** Command template; `{key}` placeholders are filled by spawn-parse.ts's fillTemplate. */
	command: string;
	/** Template-declared reachable host (R6b): used when no wrapper endpoint/advertise is seen. */
	host?: string;
}

export interface FleetConfig {
	templates: Record<string, SpawnTemplate>;
	defaultTemplate: string;
	/**
	 * Per-project template override (project basename → template name),
	 * consulted by supervisor.spawn when no explicit template is given.
	 */
	projectTemplates?: Record<string, string>;
	/** Env `OMP_FLEET_SPAWN_HOOK` wins over the config file value. */
	spawnHook?: string;
	/**
	 * Root for managed worktrees (created lazily on first worktree, never at
	 * boot). Flag `--workspace-dir` > env `OMP_FLEET_WORKSPACE_DIR` >
	 * config-file `workspaceDir` key > `~/.omp-web/workspaces` (~ expanded).
	 */
	workspaceDir: string;
	/**
	 * Address the control plane + browser edge bind. Flag `--bind` > env
	 * `OMP_FLEET_BIND` > config-file `bind` key > `127.0.0.1` (the historic
	 * loopback-only default). A non-loopback bind without browser browser
	 * auth configured is a startup error (never an unauthenticated control
	 * plane on an open address).
	 */
	bind: string;
	/**
	 * Browser auth operator credential, stored ONLY as its sha-256 hex
	 * digest. Flag `--browser-access-token` > env `OMP_FLEET_BROWSER_TOKEN`
	 * > config-file `browserAccessToken` key; the plaintext never outlives
	 * the load. Absent = browser auth DISABLED: every route behaves exactly
	 * as before this key existed.
	 */
	browserAccessTokenHash?: string;
	/**
	 * Public origin browsers use, admitted for mutations alongside the
	 * loopback-dev exception (flag `--browser-origin` > env
	 * `OMP_FLEET_BROWSER_ORIGIN` > config-file `browserOrigin` key).
	 */
	browserOrigin?: string;
	/**
	 * Trusted reverse proxies whose forwarded headers the fleet honors
	 * (P2.3): IP or CIDR literals. X-Forwarded-For / X-Forwarded-Proto
	 * shape the client-address and loopback decisions ONLY when the direct
	 * socket peer matches this list; forwarded headers from any other peer
	 * are ignored entirely (fail closed — never trusted by default). Flag
	 * `--trusted-proxy` (repeatable, each occurrence comma-splittable) >
	 * env `OMP_FLEET_TRUSTED_PROXY` (csv) > config-file `trustedProxies`
	 * key. Malformed literals are a hard load error.
	 */
	trustedProxies?: string[];
	/**
	 * Validated provider profiles (clone workspaces). Shape-valid entries only:
	 * malformed ones are dropped during load with a stderr warning. Absent
	 * unless the config file declares a `providerProfiles` key.
	 */
	providerProfiles?: Record<string, ProviderProfile>;
}

/**
 * Default local spawn template. `{labels}` expands to repeated `--label k=v`
 * args (empty string when no labels); `{resume}` expands to
 * `--resume <lastSessionFile>` when the daemon has one (empty otherwise);
 * the other placeholders are filled from the registry entry at spawn time.
 */
export const DEFAULT_LOCAL_TEMPLATE: SpawnTemplate = {
	command: "omp-web session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}",
};

/** Default managed-worktree root under the consolidated home data dir. */
export function defaultWorkspaceDir(): string {
	return expandTilde("~/.omp-web/workspaces");
}

function defaultConfig(): FleetConfig {
	return {
		templates: { local: { ...DEFAULT_LOCAL_TEMPLATE } },
		defaultTemplate: "local",
		workspaceDir: defaultWorkspaceDir(),
		bind: "127.0.0.1",
	};
}

/** Expand a leading `~` / `~/` to os.homedir(); other paths pass through. */
export function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export async function loadConfig(
	path?: string,
	opts?: {
		workspaceDir?: string;
		bind?: string;
		browserAccessToken?: string;
		browserOrigin?: string;
		/** CLI `--trusted-proxy` literals (each occurrence comma-splittable). */
		trustedProxy?: string[];
	},
): Promise<FleetConfig> {
	const file = resolveConfigPath(path);
	let config: FleetConfig;
	if (!existsSync(file)) {
		config = defaultConfig();
	} else {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			// Unreadable or corrupt config falls back to defaults.
			raw = undefined;
		}
		config = raw === undefined ? defaultConfig() : mergeConfig(raw);
	}
	// Env wins over every file source (the dev runner sets this so sidebar
	// spawns run the source entry, not the unbuilt production binary).
	const localCommand = process.env.OMP_FLEET_LOCAL_TEMPLATE;
	if (localCommand !== undefined && localCommand !== "") {
		config.templates = { ...config.templates, local: { command: localCommand } };
	}
	// Env `OMP_FLEET_SPAWN_HOOK` / `OMP_FLEET_WORKSPACE_DIR` win over the
	// config-file value AND over defaults — applied here in loadConfig, not
	// inside mergeConfig, so the overrides also hold when NO config file
	// exists (mergeConfig is skipped on the defaultConfig path). Explicit
	// CLI flags still beat env below.
	const envHook = process.env.OMP_FLEET_SPAWN_HOOK;
	if (envHook !== undefined && envHook !== "") {
		config.spawnHook = envHook;
	}
	const envWorkspaceDir = process.env.OMP_FLEET_WORKSPACE_DIR;
	if (envWorkspaceDir !== undefined && envWorkspaceDir !== "") {
		config.workspaceDir = expandTilde(envWorkspaceDir);
	}
	const flagDir = opts?.workspaceDir;
	if (flagDir !== undefined && flagDir !== "") {
		config.workspaceDir = expandTilde(flagDir);
	}
	// Bind: explicit flag (`opts.bind`) > env `OMP_FLEET_BIND` > config-file
	// `bind` (mergeConfig already applied env+file to the default).
	const flagBind = opts?.bind;
	const envBind = process.env.OMP_FLEET_BIND;
	if (flagBind !== undefined && flagBind !== "") {
		config.bind = flagBind;
	} else if (envBind !== undefined && envBind !== "") {
		config.bind = envBind;
	}
	// Browser-auth operator token: flag > env > config-file key. Only its
	// sha-256 digest is kept in config (and later in the browser-auth store);
	// the plaintext never outlives this load. (mergeConfig already applied a
	// config-file value that was pre-hashed; a flag/env plaintext overrides.)
	const flagToken = opts?.browserAccessToken;
	const envToken = process.env.OMP_FLEET_BROWSER_TOKEN;
	if (flagToken !== undefined && flagToken !== "") {
		config.browserAccessTokenHash = hashAccessToken(flagToken);
	} else if (envToken !== undefined && envToken !== "") {
		config.browserAccessTokenHash = hashAccessToken(envToken);
	}
	// Allowed mutation origin for browser sessions: flag > env > file key.
	const flagOrigin = opts?.browserOrigin;
	const envOrigin = process.env.OMP_FLEET_BROWSER_ORIGIN;
	if (flagOrigin !== undefined && flagOrigin !== "") {
		config.browserOrigin = flagOrigin;
	} else if (envOrigin !== undefined && envOrigin !== "") {
		config.browserOrigin = envOrigin;
	}
	// Trusted proxies: explicit flag (repeatable, csv per occurrence) > env
	// `OMP_FLEET_TRUSTED_PROXY` (csv) > config-file `trustedProxies`
	// (mergeConfig applied env+file already). Unresolvable literals are a
	// hard config error — a typo'd proxy must never be silently dropped
	// into a fail-open-less forwarding decision (and invalid entries never
	// match, so a drop would strand real proxies behind TLS silently).
	const flagProxies = opts?.trustedProxy;
	if (flagProxies !== undefined && flagProxies.length > 0) {
		// String entries only: the CLI's legacy multi-flag leniency can push a
		// bare boolean when a value was missing — a security flag must never
		// crash the load (it degrades to "no trusted proxies", fail closed).
		config.trustedProxies = flagProxies
			.filter((entry): entry is string => typeof entry === "string")
			.flatMap((entry) => splitTrustedProxyCsv(entry));
	}
	const configured = config.trustedProxies ?? [];
	const invalid = configured.filter((entry) => parseProxyRule(entry) === null);
	if (invalid.length > 0) {
		throw new Error(
			`invalid trusted proxy literal(s): ${invalid.map((v) => `"${v}"`).join(", ")} ` +
				"(expected IP or CIDR, e.g. 10.0.0.0/8; forwarded headers are ignored unless the direct " +
				"peer matches a configured trusted proxy)",
		);
	}
	return config;
}

/** sha-256 hex digest of the operator access token — the ONLY form kept
 *  beyond the config load; the plaintext never rides config or the store. */
function hashAccessToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Resolve the config path the loader will read (explicit > env > default). */
export function resolveConfigPath(explicit?: string): string {
	if (explicit !== undefined) return expandTilde(explicit);
	const env = process.env.OMP_FLEET_CONFIG;
	if (env !== undefined && env !== "") return expandTilde(env);
	return join(homedir(), ".omp-web", "config.json");
}

/** Shallow-merge the parsed file over the defaults; malformed/unknown fields fall back. */
function mergeConfig(raw: unknown): FleetConfig {
	const config = defaultConfig();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return config;
	const file = raw as Record<string, unknown>;
	if (isTemplateMap(file.templates)) {
		config.templates = file.templates;
	}
	if (typeof file.defaultTemplate === "string") {
		config.defaultTemplate = file.defaultTemplate;
	}
	if (isProjectTemplateMap(file.projectTemplates)) {
		config.projectTemplates = file.projectTemplates;
	}
	// Provider profiles validate total; invalid entries are dropped with an
	// actionable warning and the fleet still boots on the valid remainder.
	// A map-level failure (`providerProfiles` not an object) falls back to
	// absent, matching the projectTemplates pattern; per-entry drops (which
	// include entries whose map key is unusable) never invalidate the map.
	if (file.providerProfiles !== undefined) {
		const rawProfiles = file.providerProfiles;
		const mapUsable =
			typeof rawProfiles === "object" && rawProfiles !== null && !Array.isArray(rawProfiles);
		const { profiles, errors } = validateProfiles(file.providerProfiles);
		for (const err of errors) {
			// Map-level failure (providerProfiles not an object): label the key
			// itself. Per-entry drops always carry the entry's map key.
			const where = mapUsable ? `providerProfiles."${err.profileId}"` : "providerProfiles";
			console.error(`fleet: config: dropped ${where}: ${err.message} (${err.code})`);
		}
		if (mapUsable) {
			// Executable paths honor the config file's `~` convention
			// (expandTilde passes absolute/PATH names through untouched).
			for (const profile of Object.values(profiles)) {
				profile.executable = expandTilde(profile.executable);
			}
			config.providerProfiles = profiles;
		}
	}
	if (typeof file.spawnHook === "string") {
		config.spawnHook = expandTilde(file.spawnHook);
	}
	// Config-file workspaceDir key (env and the --workspace-dir flag are
	// applied in loadConfig, after this merge, so they also win when no
	// config file exists).
	if (typeof file.workspaceDir === "string") {
		config.workspaceDir = expandTilde(file.workspaceDir);
	}
	// Bind: env `OMP_FLEET_BIND` > config-file `bind` (a CLI flag beats both
	// in loadConfig after this merge).
	const envBind = process.env.OMP_FLEET_BIND;
	if (envBind !== undefined && envBind !== "") {
		config.bind = envBind;
	} else if (typeof file.bind === "string" && file.bind !== "") {
		config.bind = file.bind;
	}
	// Browser-auth operator credential from the config file: must already be
	// the sha-256 hex digest of the access token (the plaintext is NEVER
	// stored — a raw token in the file is a misconfiguration). Malformed →
	// hard config error, never a silent auth-disable.
	if (file.browserAccessToken !== undefined) {
		if (
			typeof file.browserAccessToken !== "string" ||
			!/^[0-9a-fA-F]{64}$/.test(file.browserAccessToken)
		) {
			throw new Error(
				"invalid config browserAccessToken: expected the 64-char sha-256 hex digest of the access token " +
					"(hash it once with `sha256sum` and configure that; the plaintext is never stored)",
			);
		}
		config.browserAccessTokenHash = file.browserAccessToken.toLowerCase();
	}
	// Allowed mutation origin: config-file `browserOrigin` key (flag/env beat
	// it in loadConfig after this merge).
	if (typeof file.browserOrigin === "string" && file.browserOrigin !== "") {
		config.browserOrigin = file.browserOrigin;
	}
	// Trusted proxies: env `OMP_FLEET_TRUSTED_PROXY` (csv) > config-file
	// `trustedProxies` key (a CLI flag beats both in loadConfig after this
	// merge). Literal validity is checked once precedence resolves.
	const envTrustedProxies = process.env.OMP_FLEET_TRUSTED_PROXY;
	if (envTrustedProxies !== undefined && envTrustedProxies !== "") {
		config.trustedProxies = splitTrustedProxyCsv(envTrustedProxies);
	} else if (isStringList(file.trustedProxies)) {
		config.trustedProxies = file.trustedProxies
			.map((entry) => entry.trim())
			.filter((entry) => entry !== "");
	}
	return config;
}

/** Split one `--trusted-proxy` occurrence or the env csv into literal
 *  entries (each comma-separated element is trimmed and empties dropped). */
function splitTrustedProxyCsv(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

/** True for a file-provided array whose elements are all strings. */
function isStringList(value: unknown): value is string[] {
	if (!Array.isArray(value)) return false;
	return value.every((entry) => typeof entry === "string");
}

function isTemplateMap(value: unknown): value is Record<string, SpawnTemplate> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every(
		(t) => typeof t === "object" && t !== null && typeof (t as SpawnTemplate).command === "string",
	);
}

function isProjectTemplateMap(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((name) => typeof name === "string");
}
