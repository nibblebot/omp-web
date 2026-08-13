/**
 * Fleet configuration: discovery roots, spawn templates, and the
 * default template, loaded from `~/.omp/fleet/config.json`.
 *
 * Resolution order: an explicit `path` argument wins, then env
 * `OMP_FLEET_CONFIG`, then the default location. A missing file yields
 * defaults; the file is shallow-merged over the defaults and unknown fields
 * are tolerated. `OMP_FLEET_SPAWN_HOOK` overrides the config file's
 * `spawnHook`; `OMP_FLEET_LOCAL_TEMPLATE` replaces the `local` template's
 * command outright (dev runners point it at the source entry when the
 * production binary isn't built). A leading `~` is expanded to
 * `os.homedir()` in paths.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SpawnTemplate {
	/** Command template; `{key}` placeholders are filled by spawn-parse.ts's fillTemplate. */
	command: string;
	/** Template-declared reachable host (R6b): used when no wrapper endpoint/advertise is seen. */
	host?: string;
}

export interface FleetConfig {
	/** Discovery roots; default `["~/repos"]` (~ expanded). */
	roots: string[];
	templates: Record<string, SpawnTemplate>;
	defaultTemplate: string;
	/**
	 * Per-project template override (project basename → template name),
	 * consulted by supervisor.spawn when no explicit template is given.
	 */
	projectTemplates?: Record<string, string>;
	/** Env `OMP_FLEET_SPAWN_HOOK` wins over the config file value. */
	spawnHook?: string;
}

/**
 * Default local spawn template. `{labels}` expands to repeated `--label k=v`
 * args (empty string when no labels); `{resume}` expands to
 * `--resume <lastSessionFile>` when the daemon has one (empty otherwise);
 * the other placeholders are filled from the registry entry at spawn time.
 */
export const DEFAULT_LOCAL_TEMPLATE: SpawnTemplate = {
	command: "omp-session --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}",
};

function defaultConfig(): FleetConfig {
	return {
		roots: [expandTilde("~/repos")],
		templates: { local: { ...DEFAULT_LOCAL_TEMPLATE } },
		defaultTemplate: "local",
	};
}

/** Expand a leading `~` / `~/` to os.homedir(); other paths pass through. */
function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

export async function loadConfig(path?: string): Promise<FleetConfig> {
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
	// Env wins over every file source (scripts/dev.ts fleet mode sets this so
	// sidebar spawns run the source entry, not the unbuilt production binary).
	const localCommand = process.env.OMP_FLEET_LOCAL_TEMPLATE;
	if (localCommand !== undefined && localCommand !== "") {
		config.templates = { ...config.templates, local: { command: localCommand } };
	}
	return config;
}

function resolveConfigPath(explicit?: string): string {
	if (explicit !== undefined) return expandTilde(explicit);
	const env = process.env.OMP_FLEET_CONFIG;
	if (env !== undefined && env !== "") return expandTilde(env);
	return join(homedir(), ".omp", "fleet", "config.json");
}

/** Shallow-merge the parsed file over the defaults; malformed/unknown fields fall back. */
function mergeConfig(raw: unknown): FleetConfig {
	const config = defaultConfig();
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return config;
	const file = raw as Record<string, unknown>;
	if (Array.isArray(file.roots) && file.roots.every((root) => typeof root === "string")) {
		config.roots = (file.roots as string[]).map(expandTilde);
	}
	if (isTemplateMap(file.templates)) {
		config.templates = file.templates;
	}
	if (typeof file.defaultTemplate === "string") {
		config.defaultTemplate = file.defaultTemplate;
	}
	if (isProjectTemplateMap(file.projectTemplates)) {
		config.projectTemplates = file.projectTemplates;
	}
	const hook = process.env.OMP_FLEET_SPAWN_HOOK;
	if (hook !== undefined && hook !== "") {
		config.spawnHook = hook;
	} else if (typeof file.spawnHook === "string") {
		config.spawnHook = expandTilde(file.spawnHook);
	}
	return config;
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
