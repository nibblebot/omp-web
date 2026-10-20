/**
 * Fleet configuration: spawn templates and the default template, loaded
 * from `~/.omp-web/config.json`.
 *
 * Resolution order: an explicit `path` argument wins, then env
 * `OMP_FLEET_CONFIG`, then the default location. A missing file yields
 * defaults; the file is shallow-merged over the defaults and unknown fields
 * are tolerated. `OMP_FLEET_LOCAL_TEMPLATE` replaces the `local` template's
 * command outright (dev runners point it at the source entry when the
 * production binary isn't built). `workspaceDir` (default directory for new
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
import { basename, join } from "node:path";
import { isExecutableProfile, type ProviderProfile } from "#lib/runtime/provider-protocol";
import { validateProfiles } from "./provider-profile";
import { parseProxyRule } from "./trusted-proxy";

export interface SpawnTemplate {
	/** Command template; `{key}` placeholders are filled by spawn-parse.ts's fillTemplate. */
	command: string;
	/** Template-declared reachable host (R6b): used when no wrapper endpoint is seen. */
	host?: string;
}

export interface FleetConfig {
	templates: Record<string, SpawnTemplate>;
	defaultTemplate: string;
	/**
	 * Per-project template override (project basename → template name),
	 * consulted by the host runtime's spawn when no explicit template is given.
	 */
	projectTemplates?: Record<string, string>;
	/**
	 * Default creation destination for local worktrees (created lazily, never
	 * at boot), not an ownership boundary. Flag `--workspace-dir` >
	 * env `OMP_FLEET_WORKSPACE_DIR` > config key > `~/.omp-web/workspaces`.
	 */
	workspaceDir: string;
	/**
	 * Set when the default-location config file exists but does not parse: the
	 * defaults are in use and this holds the reason (shown at /ctl/debug).
	 */
	loadError?: string;
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
	 * Trusted reverse proxies whose forwarded headers the fleet honors:
	 * IP or CIDR literals. X-Forwarded-For / X-Forwarded-Proto
	 * shape the client-address and loopback decisions ONLY when the direct
	 * socket peer matches this list; forwarded headers from any other peer
	 * are ignored entirely (fail closed, never trusted by default). Flag
	 * `--trusted-proxy` (repeatable, each occurrence comma-splittable) >
	 * env `OMP_FLEET_TRUSTED_PROXY` (csv) > config-file `trustedProxies`
	 * key. A listed proxy MUST append the peer it saw to X-Forwarded-For
	 * (or replace the header); the client is the rightmost untrusted hop,
	 * so a proxy that only passes a client-supplied header through lets
	 * the client pick its address. Malformed literals are a hard load error.
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
 * Resolve the template NAME for a cwd: explicit, else
 * `projectTemplates[basename(cwd)]`, else `defaultTemplate`; throws when the
 * resolved name is not in `templates`. The resolved name is stored on the
 * roster row so a later wake finds the same template.
 */
export function resolveTemplateName(
	config: Pick<FleetConfig, "templates" | "defaultTemplate" | "projectTemplates">,
	cwd: string,
	explicit?: string,
): string {
	const name = explicit ?? config.projectTemplates?.[basename(cwd)] ?? config.defaultTemplate;
	if (config.templates[name] === undefined) throw new Error(`unknown spawn template: ${name}`);
	return name;
}

/**
 * Default local spawn template. `{fleet}` expands to `--fleet-stdin`: the fleet writes the
 * daemon's callback pair and listener token to its stdin, never to argv or env. `{labels}`
 * expands to repeated `--label k=v` args (empty string when no labels). `{resume}` expands to
 * `--resume <lastSessionFile>` when the daemon's file was persisted, else
 * `--resume <lastSessionFile> --resume-unwritten` (a never-prompted session's path may not exist
 * yet); empty when the daemon has none. The other placeholders are filled from the registry
 * entry at spawn time.
 */
export const DEFAULT_LOCAL_TEMPLATE: SpawnTemplate = {
	command: "omp-web session --cwd {cwd} --port 0 {fleet} --name {name} {labels} {resume}",
};

/** Default worktree creation directory under the consolidated home data dir. */
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
	// A config the operator named (argument or OMP_FLEET_CONFIG) must load: an
	// unparsable file there is a startup error, never silent defaults.
	const explicit = path !== undefined || (process.env.OMP_FLEET_CONFIG ?? "") !== "";
	let config: FleetConfig;
	let loadError: string | undefined;
	if (!existsSync(file)) {
		config = defaultConfig();
	} else {
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(file, "utf8"));
		} catch (error) {
			const reason = `${file}: ${error instanceof Error ? error.message : String(error)}`;
			if (explicit) throw new Error(`fleet: config: unparsable ${reason}`);
			// The default-location file is corrupt: boot on defaults, but log it and surface it at /ctl/debug.
			console.error(`fleet: config: unparsable ${reason}; using defaults`);
			loadError = reason;
			raw = undefined;
		}
		config = raw === undefined ? defaultConfig() : mergeConfig(raw);
	}
	if (loadError !== undefined) config.loadError = loadError;
	// Env wins over every file source (the dev runner sets this so sidebar
	// spawns run the source entry, not the unbuilt production binary).
	const localCommand = process.env.OMP_FLEET_LOCAL_TEMPLATE;
	if (localCommand !== undefined && localCommand !== "") {
		config.templates = { ...config.templates, local: { command: localCommand } };
	}
	// Every template hands its daemon the callback pair and listener token on stdin (`{fleet}`):
	// a `{token}` placeholder would put the listener token in argv, visible to every local user,
	// and a template without `{fleet}` would start a daemon that never pairs.
	for (const [name, template] of Object.entries(config.templates)) {
		if (template.command.includes("{token}")) {
			throw new Error(
				`fleet template "${name}" uses {token}; replace \`--token {token}\` with {fleet} (the token travels on --fleet-stdin)`,
			);
		}
		if (!template.command.includes("{fleet}")) {
			throw new Error(
				`fleet template "${name}" lacks {fleet}; add {fleet} (expands to --fleet-stdin) so the daemon reads its callback pair from stdin`,
			);
		}
	}
	// Env `OMP_FLEET_WORKSPACE_DIR` wins over the config-file value AND over
	// defaults, applied here in loadConfig, not inside mergeConfig, so the
	// override also holds when NO config file exists (mergeConfig is skipped
	// on the defaultConfig path). Explicit CLI flags still beat env below.
	const envWorkspaceDir = process.env.OMP_FLEET_WORKSPACE_DIR;
	if (envWorkspaceDir !== undefined && envWorkspaceDir !== "") {
		config.workspaceDir = expandTilde(envWorkspaceDir);
	}
	const flagDir = opts?.workspaceDir;
	if (flagDir !== undefined && flagDir !== "") {
		config.workspaceDir = expandTilde(flagDir);
	}
	// Bind: explicit flag (`opts.bind`) > env `OMP_FLEET_BIND` > config-file
	// `bind` (mergeConfig already applied the file).
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
	// Trusted proxies: flag (repeatable, csv per occurrence) > env
	// `OMP_FLEET_TRUSTED_PROXY` (csv) > config-file `trustedProxies`
	// (mergeConfig applied the file). Env is read here, not in mergeConfig,
	// so it also holds when NO config file exists (FPS-14).
	// String entries only: a bare boolean from the CLI must never crash the load.
	const flagProxies = (opts?.trustedProxy ?? [])
		.filter((entry): entry is string => typeof entry === "string")
		.flatMap((entry) => splitTrustedProxyCsv(entry));
	const envProxies = process.env.OMP_FLEET_TRUSTED_PROXY;
	if (flagProxies.length > 0) {
		config.trustedProxies = flagProxies;
	} else if (envProxies !== undefined && envProxies !== "") {
		config.trustedProxies = splitTrustedProxyCsv(envProxies);
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

/** sha-256 hex digest of the operator access token, the ONLY form kept
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
				if (isExecutableProfile(profile)) profile.executable = expandTilde(profile.executable);
			}
			config.providerProfiles = profiles;
		}
	}
	// Config-file workspaceDir key (env and the --workspace-dir flag are
	// applied in loadConfig, after this merge, so they also win when no
	// config file exists).
	if (typeof file.workspaceDir === "string") {
		config.workspaceDir = expandTilde(file.workspaceDir);
	}
	// Bind: config-file `bind` (env and a CLI flag beat it in loadConfig after this merge).
	if (typeof file.bind === "string" && file.bind !== "") {
		config.bind = file.bind;
	}
	// Browser-auth operator credential from the config file: must already be
	// the sha-256 hex digest of the access token (the plaintext is NEVER
	// stored; a raw token in the file is a misconfiguration). Malformed →
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
	// Trusted proxies: config-file `trustedProxies` key (env and the CLI flag
	// beat it in loadConfig after this merge). Literal validity is checked once
	// precedence resolves.
	if (isStringList(file.trustedProxies)) {
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
