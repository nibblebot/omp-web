/**
 * Unit tests for lib/runtime/sandbox-baseline.ts: allowlist sanitization, the
 * operator config source resolution (override, agent dir, XDG, home), and
 * the best-effort volume seed. Every scratch dir comes from tempDir(); the
 * env-driven resolution rungs are exercised with explicit env records so
 * the suite never depends on the machine's real ~/.omp.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { YAML } from "bun";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelsConfigFile } from "@oh-my-pi/pi-coding-agent/config/models-config";
import { cleanupTempDirs, tempDir } from "../../testkit/temp-dir.testkit";
import {
	resolveBaselineSourcePath,
	sanitizeBaselineConfig,
	sanitizeModelsConfig,
	seedSandboxBaseline,
} from "../sandbox-baseline";

afterAll(cleanupTempDirs);

const SEED_COMMENT_PREFIX = "# Seeded from the operator's global config";

/** A config.yml fixture mixing allowlisted, denied, and junk keys. */
function writeSourceConfig(contents: string): { dir: string; path: string } {
	const dir = tempDir("omp-sb-src-");
	const path = join(dir, "config.yml");
	writeFileSync(path, contents);
	return { dir, path };
}

describe("sanitizeBaselineConfig", () => {
	test("keeps nested allowlisted keys and drops non-allowlisted roots", () => {
		const result = sanitizeBaselineConfig({
			modelRoles: { default: "architect" },
			retry: { maxRetries: 4, maxDelayMs: 2000 },
			compaction: { thresholdPercent: 25, enabled: true },
			bash: { patterns: ["allowed/one", "allowed/two"] },
			theme: { dark: true },
			tui: { tight: true },
			startup: { checkUpdate: false },
		});
		expect(result).toEqual({
			modelRoles: { default: "architect" },
			retry: { maxRetries: 4, maxDelayMs: 2000 },
			compaction: { thresholdPercent: 25, enabled: true },
			bash: { patterns: ["allowed/one", "allowed/two"] },
		});
	});

	test("drops the compaction.remote* sub-denied keys, keeping compaction itself", () => {
		const result = sanitizeBaselineConfig({
			compaction: {
				enabled: true,
				thresholdPercent: 25,
				remoteEnabled: true,
				remoteEndpoint: "https://compaction.example.com",
				remoteStreamingV2Enabled: true,
				autoCompact: true,
			},
		});
		expect(result).toEqual({
			compaction: { enabled: true, thresholdPercent: 25, autoCompact: true },
		});
	});

	test("drops host-bound scalar strings under allowlisted keys", () => {
		const result = sanitizeBaselineConfig({
			retry: {
				maxRetries: 3,
				someEndpoint: "https://retry.example.com",
				somePath: "/etc/passwd",
				someHome: "~/secrets/id_rsa",
				keepMe: "plain-value",
			},
		});
		expect(result).toEqual({ retry: { maxRetries: 3, keepMe: "plain-value" } });
	});

	test("filters host-bound elements out of kept string arrays", () => {
		const result = sanitizeBaselineConfig({
			modelProviderOrder: ["/abs", "moonshot/kimi-k2.7-code", "~/rel", "https://x"],
		});
		expect(result).toEqual({ modelProviderOrder: ["moonshot/kimi-k2.7-code"] });
	});

	test("returns {} for non-plain-object input", () => {
		for (const input of [null, "str", [1, 2], 42, true]) {
			expect(sanitizeBaselineConfig(input)).toEqual({});
		}
	});
});

describe("resolveBaselineSourcePath", () => {
	test("returns the OMP_SANDBOX_BASELINE_CONFIG override when it exists", () => {
		const { path } = writeSourceConfig("temperature: 0.4\n");
		expect(resolveBaselineSourcePath({ OMP_SANDBOX_BASELINE_CONFIG: path })).toBe(path);
	});

	test("override pointing at a missing file resolves to null with no fallthrough", () => {
		const agentDir = tempDir("omp-sb-agent-");
		writeFileSync(join(agentDir, "config.yml"), "temperature: 0.4\n");
		const env = {
			OMP_SANDBOX_BASELINE_CONFIG: join(agentDir, "does-not-exist.yml"),
			PI_CODING_AGENT_DIR: agentDir,
		};
		expect(resolveBaselineSourcePath(env)).toBeNull();
	});

	test("finds config.yaml under PI_CODING_AGENT_DIR when it is the only file", () => {
		const agentDir = tempDir("omp-sb-agent-");
		const yamlPath = join(agentDir, "config.yaml");
		writeFileSync(yamlPath, "temperature: 0.4\n");
		expect(resolveBaselineSourcePath({ PI_CODING_AGENT_DIR: agentDir })).toBe(yamlPath);
	});

	test("prefers config.yml over config.yaml and PI_CODING_AGENT_DIR over XDG_DATA_HOME", () => {
		const agentDir = tempDir("omp-sb-agent-");
		const xdgDir = tempDir("omp-sb-xdg-");
		const ymlPath = join(agentDir, "config.yml");
		const yamlPath = join(agentDir, "config.yaml");
		writeFileSync(ymlPath, "temperature: 0.4\n");
		writeFileSync(yamlPath, "temperature: 0.5\n");
		const xdgPath = join(xdgDir, "omp", "agent", "config.yml");
		mkdirSync(join(xdgDir, "omp", "agent"), { recursive: true });
		writeFileSync(xdgPath, "temperature: 0.6\n");
		expect(
			resolveBaselineSourcePath({ PI_CODING_AGENT_DIR: agentDir, XDG_DATA_HOME: xdgDir }),
		).toBe(ymlPath);
	});

	test("falls back to XDG_DATA_HOME/omp/agent then HOME/.omp/agent", () => {
		const xdgDir = tempDir("omp-sb-xdg-");
		const xdgPath = join(xdgDir, "omp", "agent", "config.yaml");
		mkdirSync(join(xdgDir, "omp", "agent"), { recursive: true });
		writeFileSync(xdgPath, "temperature: 0.4\n");
		expect(resolveBaselineSourcePath({ XDG_DATA_HOME: xdgDir })).toBe(xdgPath);

		const homeDir = tempDir("omp-sb-home-");
		const homePath = join(homeDir, ".omp", "agent", "config.yml");
		mkdirSync(join(homeDir, ".omp", "agent"), { recursive: true });
		writeFileSync(homePath, "temperature: 0.5\n");
		// HOME is the third rung; XDG with no config falls through to it.
		expect(
			resolveBaselineSourcePath({ XDG_DATA_HOME: tempDir("omp-sb-xdg-empty-"), HOME: homeDir }),
		).toBe(homePath);
	});

	test("an empty env record resolves to null (no process.env fallthrough)", () => {
		expect(resolveBaselineSourcePath({})).toBeNull();
	});
});

describe("seedSandboxBaseline", () => {
	test("seeds a sanitized config at <vol>/.home/agent/config.yml from sourcePath", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const { path: sourcePath } = writeSourceConfig(`modelRoles:
  default: architect
retry:
  maxRetries: 3
compaction:
  remoteEnabled: true
  enabled: true
credentials:
  apiKey: sk-abc123
theme:
  dark: true
`);
		const result = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath });
		expect(result).toMatchObject({
			seeded: true,
			source: sourcePath,
			modelsReason: "no-source",
		});

		const target = join(volumeRoot, ".home", "agent", "config.yml");
		expect(existsSync(target)).toBe(true);
		const raw = readFileSync(target, "utf8");
		expect(raw.startsWith(SEED_COMMENT_PREFIX)).toBe(true);
		const parsed = YAML.parse(raw) as Record<string, unknown>;
		expect(parsed).toEqual({
			modelRoles: { default: "architect" },
			retry: { maxRetries: 3 },
			compaction: { enabled: true },
		});
	});

	test("never overwrites an existing target and leaves its bytes untouched", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const { path: sourcePath } = writeSourceConfig(`modelRoles:
  default: architect
`);
		const first = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath });
		expect(first.seeded).toBe(true);

		const target = join(volumeRoot, ".home", "agent", "config.yml");
		const handEdit = `modelRoles:\n  default: edited-by-hand\n`;
		writeFileSync(target, handEdit);

		const second = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath });
		expect(second).toMatchObject({ seeded: false, reason: "exists" });
		expect(readFileSync(target, "utf8")).toBe(handEdit);
	});

	test("reports no-source with an empty env and no sourcePath", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const result = await seedSandboxBaseline(volumeRoot, { env: {} });
		expect(result).toMatchObject({ seeded: false, reason: "no-source" });
		expect(existsSync(join(volumeRoot, ".home", "agent", "config.yml"))).toBe(false);

		// An explicit but missing sourcePath also reports no-source.
		const missing = await seedSandboxBaseline(volumeRoot, {
			env: {},
			sourcePath: join(volumeRoot, "missing.yml"),
		});
		expect(missing).toMatchObject({ seeded: false, reason: "no-source" });
	});

	test("reports unparseable when the source YAML is malformed", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const { path: sourcePath } = writeSourceConfig("a: [unclosed\n");
		const result = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath });
		expect(result).toMatchObject({ seeded: false, reason: "unparseable" });
		expect(existsSync(join(volumeRoot, ".home", "agent", "config.yml"))).toBe(false);
	});

	test("reports empty-after-filter when the source holds only non-allowlisted keys", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const { path: sourcePath } = writeSourceConfig(`theme:
  dark: true
startup:
  checkUpdate: false
tui:
  tight: true
`);
		const result = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath });
		expect(result).toMatchObject({ seeded: false, reason: "empty-after-filter" });
		expect(existsSync(join(volumeRoot, ".home", "agent", "config.yml"))).toBe(false);
	});

	test("resolves the source from env when no sourcePath is given", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const agentDir = tempDir("omp-sb-agent-");
		const sourcePath = join(agentDir, "config.yml");
		writeFileSync(sourcePath, "temperature: 0.4\n");
		const result = await seedSandboxBaseline(volumeRoot, {
			env: { PI_CODING_AGENT_DIR: agentDir },
		});
		expect(result).toMatchObject({ seeded: true, source: sourcePath });
		const raw = readFileSync(join(volumeRoot, ".home", "agent", "config.yml"), "utf8");
		expect((YAML.parse(raw) as Record<string, unknown>).temperature).toBe(0.4);
	});
});

describe("sanitizeModelsConfig", () => {
	const ENV: Record<string, string | undefined> = { TOKENROUTER_API_KEY: "x", MY_HEADER_VAR: "y" };

	test("rewrites a literal provider apiKey to the convention env name and records it", () => {
		const result = sanitizeModelsConfig(
			{
				providers: {
					tokenrouter: {
						baseUrl: "https://api.tokenrouter.com/v1",
						apiKey: "sk-literal-secret",
					},
				},
			},
			ENV,
		);
		expect(result.config).toEqual({
			providers: {
				tokenrouter: {
					baseUrl: "https://api.tokenrouter.com/v1",
					apiKey: "TOKENROUTER_API_KEY",
				},
			},
		});
		expect(result.requiredEnvKeys).toEqual(["TOKENROUTER_API_KEY"]);
	});

	test("keeps an env-reference apiKey verbatim when the name is present in env", () => {
		const result = sanitizeModelsConfig(
			{
				providers: {
					tokenrouter: { apiKey: "TOKENROUTER_API_KEY", baseUrl: "https://x" },
				},
			},
			ENV,
		);
		expect((result.config.providers as Record<string, { apiKey: string }>).tokenrouter.apiKey).toBe(
			"TOKENROUTER_API_KEY",
		);
		expect(result.requiredEnvKeys).toEqual(["TOKENROUTER_API_KEY"]);
	});

	test("rewrites an identifier-shaped apiKey absent from env (treated as literal secret)", () => {
		// `MYSTERY_KEY` is a valid identifier but absent from env: the models
		// runtime would treat it as a literal secret, so it never crosses as
		// itself; the provider apiKey is rewritten to the convention name.
		const result = sanitizeModelsConfig(
			{ providers: { p: { apiKey: "MYSTERY_KEY", baseUrl: "https://x" } } },
			ENV,
		);
		expect(result.config).toEqual({
			providers: { p: { apiKey: "P_API_KEY", baseUrl: "https://x" } },
		});
		expect(result.requiredEnvKeys).toEqual(["P_API_KEY"]);
	});

	test("rewrites a bang-command apiKey to the convention name (host command never crosses)", () => {
		const result = sanitizeModelsConfig(
			{
				providers: {
					bad: { apiKey: "!pass show SECRET", baseUrl: "https://x" },
					open: { apiKey: "!cmd echo hi", auth: "none", baseUrl: "https://y" },
				},
			},
			ENV,
		);
		expect(result.config).toEqual({
			providers: {
				bad: { apiKey: "BAD_API_KEY", baseUrl: "https://x" },
				open: { apiKey: "OPEN_API_KEY", auth: "none", baseUrl: "https://y" },
			},
		});
		expect(result.requiredEnvKeys).toEqual(["BAD_API_KEY", "OPEN_API_KEY"]);
	});

	test("drops a transport pi-native provider entirely", () => {
		const result = sanitizeModelsConfig(
			{
				providers: {
					gateway: {
						transport: "pi-native",
						baseUrl: "https://auth-gateway.internal",
						apiKey: "some-bearer",
					},
					normal: { baseUrl: "https://x", apiKey: "TOKENROUTER_API_KEY" },
				},
			},
			ENV,
		);
		expect(result.config).toEqual({
			providers: { normal: { baseUrl: "https://x", apiKey: "TOKENROUTER_API_KEY" } },
		});
	});

	test("keeps env-reference headers and drops literal headers regardless of header name", () => {
		const result = sanitizeModelsConfig(
			{
				providers: {
					p: {
						baseUrl: "https://x",
						headers: {
							Authorization: "MY_HEADER_VAR",
							"X-Api-Key": "literal-leak",
							"X-Innocuous": "also-literal",
						},
					},
				},
			},
			ENV,
		);
		const provider = (result.config.providers as Record<string, { headers: unknown }>).p;
		expect(provider.headers).toEqual({ Authorization: "MY_HEADER_VAR" });
		expect(result.requiredEnvKeys).toContain("MY_HEADER_VAR");
		expect(result.requiredEnvKeys).not.toContain("literal-leak");
	});

	test("keeps baseUrl URLs untouched (no URL shape-deny in models.yml)", () => {
		const result = sanitizeModelsConfig(
			{
				providers: {
					p: { baseUrl: "https://api.example.com/v1", apiKey: "TOKENROUTER_API_KEY" },
				},
			},
			ENV,
		);
		const provider = (result.config.providers as Record<string, { baseUrl: string }>).p;
		expect(provider.baseUrl).toBe("https://api.example.com/v1");
	});

	test("scrubs model-level headers literals the same way", () => {
		const result = sanitizeModelsConfig(
			{
				providers: {
					p: {
						baseUrl: "https://x",
						models: [
							{
								id: "m1",
								api: "openai-completions",
								headers: {
									Authorization: "MY_HEADER_VAR",
									"X-Api-Key": "model-leak",
								},
							},
						],
					},
				},
			},
			ENV,
		);
		const models = (
			(result.config.providers as Record<string, { models: unknown[] }>).p.models as Array<{
				headers?: Record<string, string>;
			}>
		)[0];
		expect(models.headers).toEqual({ Authorization: "MY_HEADER_VAR" });
		expect(result.requiredEnvKeys).toEqual(["MY_HEADER_VAR"]);
	});

	test("returns empty config when every provider is dropped", () => {
		const result = sanitizeModelsConfig(
			{
				providers: {
					one: { transport: "pi-native", apiKey: "lit", baseUrl: "https://x" },
					two: { transport: "pi-native", apiKey: "lit2", baseUrl: "https://y" },
				},
			},
			ENV,
		);
		expect(result.config).toEqual({});
		expect(result.requiredEnvKeys).toEqual([]);
	});

	test("returns {} for non-plain-object input", () => {
		for (const input of [null, "str", [1, 2], 42, true]) {
			expect(sanitizeModelsConfig(input, ENV)).toEqual({ config: {}, requiredEnvKeys: [] });
		}
	});
});

describe("seedSandboxBaseline models.yml", () => {
	/** Write config.yml + sibling models.yml into one baseline dir. */
	function writeBaseline(contents: { config: string; models?: string }): {
		dir: string;
		configPath: string;
		modelsPath: string | null;
	} {
		const dir = tempDir("omp-sb-baseline-");
		const configPath = join(dir, "config.yml");
		writeFileSync(configPath, contents.config);
		const models = contents.models;
		if (models !== undefined) {
			const modelsPath = join(dir, "models.yml");
			writeFileSync(modelsPath, models);
			return { dir, configPath, modelsPath };
		}
		return { dir, configPath, modelsPath: null };
	}

	test("seeds a sibling models.yml at <vol>/.home/agent/models.yml from the source dir", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const { configPath } = writeBaseline({
			config: `modelRoles:\n  default: tokenrouter/kimi\ntemperature: 0.4\n`,
			models:
				`providers:\n  tokenrouter:\n    baseUrl: https://api.tokenrouter.example.com/v1\n` +
				`    apiKey: lit-secret-key\n`,
		});
		const result = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath: configPath });
		expect(result).toMatchObject({ seeded: true, modelsSeeded: true });
		expect(result.requiredEnvKeys).toEqual(["TOKENROUTER_API_KEY"]);

		const target = join(volumeRoot, ".home", "agent", "models.yml");
		expect(existsSync(target)).toBe(true);
		const raw = readFileSync(target, "utf8");
		expect(raw.startsWith("# Seeded")).toBe(true);
		expect(raw).not.toContain("lit-secret-key");
		const parsed = YAML.parse(raw) as {
			providers: Record<string, { apiKey: string; baseUrl: string }>;
		};
		expect(parsed.providers.tokenrouter.apiKey).toBe("TOKENROUTER_API_KEY");
		expect(parsed.providers.tokenrouter.baseUrl).toBe("https://api.tokenrouter.example.com/v1");
	});

	test("never overwrites an existing models.yml target (no-clobber)", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const { configPath } = writeBaseline({
			config: `temperature: 0.4\n`,
			models: `providers:\n  tokenrouter:\n    apiKey: TOKENROUTER_API_KEY\n`,
		});
		const first = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath: configPath });
		expect(first.modelsSeeded).toBe(true);

		const target = join(volumeRoot, ".home", "agent", "models.yml");
		const handEdit = `providers:\n  hand: { apiKey: HAND_KEY }\n`;
		writeFileSync(target, handEdit);

		const second = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath: configPath });
		expect(second).toMatchObject({ modelsReason: "exists" });
		expect(readFileSync(target, "utf8")).toBe(handEdit);
	});

	test("reports no-source when no models.yml exists and env is empty", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const result = await seedSandboxBaseline(volumeRoot, { env: {} });
		expect(result).toMatchObject({ seeded: false, reason: "no-source", modelsReason: "no-source" });
	});

	test("reports unparseable when the sibling models.yml is malformed", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const { configPath } = writeBaseline({
			config: `temperature: 0.4\n`,
			models: `providers: [unclosed\n`,
		});
		const result = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath: configPath });
		expect(result).toMatchObject({ seeded: true, modelsReason: "unparseable" });
		expect(existsSync(join(volumeRoot, ".home", "agent", "models.yml"))).toBe(false);
	});

	test("reports empty-after-filter when the sibling models.yml has no usable providers", async () => {
		// Blank document and a document whose every provider is dropped both
		// report empty-after-filter; no empty models.yml file is seeded.
		for (const models of [
			"",
			`providers:\n  p:\n    transport: pi-native\n    baseUrl: https://x\n`,
		]) {
			const volumeRoot = tempDir("omp-sb-vol-");
			const dir = tempDir("omp-sb-emptymodels-");
			const configPath = join(dir, "config.yml");
			writeFileSync(configPath, "temperature: 0.4\n");
			writeFileSync(join(dir, "models.yml"), models);
			const result = await seedSandboxBaseline(volumeRoot, {
				env: {},
				sourcePath: configPath,
			});
			expect(result).toMatchObject({ seeded: true, modelsReason: "empty-after-filter" });
			expect(existsSync(join(volumeRoot, ".home", "agent", "models.yml"))).toBe(false);
		}
	});

	test("sorts and dedupes requiredEnvKeys across rewrites and kept refs", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const { configPath } = writeBaseline({
			config: `temperature: 0.4\n`,
			models:
				`providers:\n  a-provider:\n    apiKey: A_PROVIDER_API_KEY\n` +
				`    headers:\n      X-A: HEADER_A\n  b:\n    apiKey: B_API_KEY\n`,
		});
		// env must present the refs so they are kept verbatim rather than dropped
		const env = {
			A_PROVIDER_API_KEY: "1",
			HEADER_A: "2",
			B_API_KEY: "3",
		};
		const result = await seedSandboxBaseline(volumeRoot, { env, sourcePath: configPath });
		expect(result.modelsSeeded).toBe(true);
		expect(result.requiredEnvKeys).toEqual(["A_PROVIDER_API_KEY", "B_API_KEY", "HEADER_A"]);
	});
});

describe("seedSandboxBaseline role coherence", () => {
	function writeRoleBaseline(contents: { config: string; models?: string }): string {
		const dir = tempDir("omp-sb-roles-");
		const configPath = join(dir, "config.yml");
		writeFileSync(configPath, contents.config);
		if (contents.models !== undefined) {
			writeFileSync(join(dir, "models.yml"), contents.models);
		}
		return configPath;
	}

	test("drops unresolvable roles and prunes cycleOrder, keeps resolvable custom + catalog", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const sourcePath = writeRoleBaseline({
			config: `modelRoles:
  default: tokenrouter/kimi-k2.7
  legacy: ghost-provider/ghost
  oauthy: oauth-provider/model
  codey: deepseek/deepseek-chat
cycleOrder:
  - default
  - legacy
temperature: 0.4
`,
			models: `providers:
  tokenrouter:
    baseUrl: https://api.tokenrouter.example.com/v1
    apiKey: TOKENROUTER_API_KEY
  oauth-provider:
    auth: oauth
    baseUrl: https://oauth.example.com
`,
		});
		// tokenrouter resolves (injected env), deepseek is a real catalog
		// provider (DEEPSEEK_API_KEY injected), ghost-provider and oauth-provider
		// do not resolve.
		const result = await seedSandboxBaseline(volumeRoot, {
			env: {},
			sandboxEnvKeys: ["TOKENROUTER_API_KEY", "DEEPSEEK_API_KEY"],
			sourcePath,
		});
		expect(result.seeded).toBe(true);
		const parsed = YAML.parse(
			readFileSync(join(volumeRoot, ".home", "agent", "config.yml"), "utf8"),
		) as Record<string, unknown>;
		expect(parsed.modelRoles).toEqual({
			default: "tokenrouter/kimi-k2.7",
			codey: "deepseek/deepseek-chat",
		});
		expect(parsed.cycleOrder).toEqual(["default"]);
	});

	test("multi-var catalog provider resolves through any of its env names", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		// moonshot's catalog entry carries [MOONSHOT_API_KEY, KIMI_API_KEY];
		// injecting either alias must make the provider resolvable.
		const sourcePath = writeRoleBaseline({
			config: `modelRoles:
  default: moonshot/kimi-k2.7
temperature: 0.4
`,
		});
		const result = await seedSandboxBaseline(volumeRoot, {
			env: {},
			sandboxEnvKeys: ["KIMI_API_KEY"],
			sourcePath,
		});
		expect(result.seeded).toBe(true);
		const parsed = YAML.parse(
			readFileSync(join(volumeRoot, ".home", "agent", "config.yml"), "utf8"),
		) as Record<string, unknown>;
		expect(parsed.modelRoles).toEqual({ default: "moonshot/kimi-k2.7" });
	});
	test("injected auth broker makes OAuth-only catalog and models.yml providers resolvable", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		// kimi-code is a catalog provider with no envVars (OAuth device flow);
		// sso is a custom auth:"oauth" provider. Both resolve only via the
		// broker, never via an env var.
		const sourcePath = writeRoleBaseline({
			config: `modelRoles:
  default: kimi-code/k3-256k
  sso: sso/model-x
temperature: 0.4
`,
			models: `providers:
  sso:
    auth: oauth
    baseUrl: https://sso.example.com
`,
		});
		const result = await seedSandboxBaseline(volumeRoot, {
			env: {},
			sandboxEnvKeys: ["OMP_AUTH_BROKER_URL", "OMP_AUTH_BROKER_TOKEN"],
			sourcePath,
		});
		expect(result.seeded).toBe(true);
		const parsed = YAML.parse(
			readFileSync(join(volumeRoot, ".home", "agent", "config.yml"), "utf8"),
		) as Record<string, unknown>;
		expect(parsed.modelRoles).toEqual({ default: "kimi-code/k3-256k", sso: "sso/model-x" });
	});

	test("broker URL without the token does not count (SDK boot-errors on that pair)", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const sourcePath = writeRoleBaseline({
			config: `modelRoles:
  default: kimi-code/k3-256k
temperature: 0.4
`,
		});
		const result = await seedSandboxBaseline(volumeRoot, {
			env: {},
			sandboxEnvKeys: ["OMP_AUTH_BROKER_URL"],
			sourcePath,
		});
		expect(result.seeded).toBe(true);
		const parsed = YAML.parse(
			readFileSync(join(volumeRoot, ".home", "agent", "config.yml"), "utf8"),
		) as Record<string, unknown>;
		expect("modelRoles" in parsed).toBe(false);
	});

	test("modelRoles and cycleOrder keys are deleted when every entry is dropped", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const sourcePath = writeRoleBaseline({
			config: `modelRoles:
  legacy: ghost-provider/ghost
cycleOrder:
  - legacy
temperature: 0.4
`,
			models: `providers: {}\n`,
		});
		const result = await seedSandboxBaseline(volumeRoot, {
			env: {},
			sandboxEnvKeys: [],
			sourcePath,
		});
		expect(result.seeded).toBe(true);
		const parsed = YAML.parse(
			readFileSync(join(volumeRoot, ".home", "agent", "config.yml"), "utf8"),
		) as Record<string, unknown>;
		expect("modelRoles" in parsed).toBe(false);
		expect("cycleOrder" in parsed).toBe(false);
	});

	test("sandboxEnvKeys omitted leaves roles byte-identical", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const sourcePath = writeRoleBaseline({
			config: `modelRoles:
  default: tokenrouter/kimi-k2.7
cycleOrder:
  - default
temperature: 0.4
`,
			models: `providers:\n  tokenrouter:\n    apiKey: TOKENROUTER_API_KEY\n`,
		});
		const unfiltered = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath });
		const unparsed = YAML.parse(
			readFileSync(join(volumeRoot, ".home", "agent", "config.yml"), "utf8"),
		) as Record<string, unknown>;
		expect(unparsed.modelRoles).toEqual({ default: "tokenrouter/kimi-k2.7" });
		expect(unparsed.cycleOrder).toEqual(["default"]);
		expect(unfiltered.modelsSeeded).toBe(true);
	});
});

describe("seeded models.yml read-side schema proof", () => {
	test("the seeded models.yml parses through the SDK ModelsConfigFile loader", async () => {
		const volumeRoot = tempDir("omp-sb-vol-");
		const dir = tempDir("omp-sb-proof-");
		const configPath = join(dir, "config.yml");
		writeFileSync(configPath, "temperature: 0.4\n");
		writeFileSync(
			join(dir, "models.yml"),
			`providers:\n  tokenrouter:\n    baseUrl: https://api.tokenrouter.example.com/v1\n` +
				`    apiKey: TOKENROUTER_API_KEY\n    api: openai-completions\n` +
				`    discovery:\n      type: openai-models-list\n`,
		);
		const result = await seedSandboxBaseline(volumeRoot, { env: {}, sourcePath: configPath });
		expect(result.modelsSeeded).toBe(true);

		const modelsPath = join(volumeRoot, ".home", "agent", "models.yml");
		const loaded = ModelsConfigFile.relocate(modelsPath).tryLoad();
		expect(loaded.status).toBe("ok");
		if (loaded.status === "ok") {
			const providers = loaded.value.providers as Record<
				string,
				{ apiKey?: string; baseUrl?: string }
			>;
			expect(providers.tokenrouter).toBeDefined();
			expect(providers.tokenrouter.apiKey).toBe("TOKENROUTER_API_KEY");
		}
	});
});
