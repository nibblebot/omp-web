/**
 * `prepareWorkspace` sandbox baseline seeding: a real local git repo is the
 * clone source (exactly like the fleet suite's fixtures, operator git
 * identity only, never a config write or `-c` override), and the operator
 * global-config resolution env is pointed at fixture or empty dirs so the
 * assertions exercise the REAL `lib/runtime/sandbox-baseline.ts` resolution and
 * sanitization paths end to end.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { cleanupTempDirs, tempDir } from "../../testkit/temp-dir.testkit";
import {
	prepareWorkspace,
	WORKSPACE_PREP_VERSION,
	type PrepareWorkspaceResult,
} from "../prepare-workspace";

afterAll(cleanupTempDirs);

/** One `git -C <cwd> <args>` invocation (throws on failure). */
async function git(cwd: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	const read = async (stream: ReadableStream<Uint8Array>): Promise<string> =>
		await new Response(stream).text();
	const [stdout, stderr] = await Promise.all([read(proc.stdout), read(proc.stderr)]);
	const code = await proc.exited;
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr}`);
	return stdout.trim();
}

/** Real local git repo with one commit on `main` (operator identity only). */
async function makeRepo(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await git(dir, ["init", "-q", "-b", "main"]);
	writeFileSync(join(dir, "readme.md"), "hello\n");
	await git(dir, ["add", "."]);
	await git(dir, ["commit", "-q", "-m", "init"]);
	return dir;
}

/** Operator global config mixing allowlisted and non-allowlisted keys. */
const BASELINE_FIXTURE = `modelRoles:
  default: default
enabledModels:
  - opus
  - haiku
disabledProviders:
  - openrouter
modelProviderOrder:
  - anthropic
  - openai
temperature: 0.4
topP: 0.9
tier: t2
model:
  loopGuard:
    maxIterations: 20
retry:
  maxAttempts: 3
tools:
  approval:
    mode: on-failure
  approvalMode: on-failure
bash:
  patterns:
    - allowed/one
    - allowed/two
    - /absolute/host/path
    - https://host.example.com/script.sh
    - ~/host-relative/tool
plan:
  defaultOnStartup: true
memory:
  backend: local
compaction:
  remoteEnabled: true
  remoteEndpoint: https://compaction.example.com
  autoCompact: true
credentials:
  apiKey: sk-abc123
interpreter:
  absolutePath: /usr/bin/python3
ownerHome: ~/secrets/owner.pem
ownerUrl: https://operator.example.com/token
cycleOrder:
  - claude-opus-4-1
  - "gpt-4o"
`;

interface EnvVar {
	name: string;
	value: string | undefined;
}

/** Capture every env var named by `names`; the restore value of an unset var is undefined. */
function captureEnv(names: string[]): EnvVar[] {
	return names.map((name) => ({ name, value: process.env[name] }));
}

function restoreEnv(saved: EnvVar[]): void {
	for (const { name, value } of saved) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

describe("prepareWorkspace sandbox baseline seeding", () => {
	test("fresh prepare seeds a sanitized baseline config and writes the verified marker", async () => {
		const source = await makeRepo(tempDir("omp-prep-src-"));
		const volumeRoot = tempDir("omp-prep-vol-");
		const baseline = tempDir("omp-prep-baseline-");
		const baselinePath = join(baseline, "config.yml");
		writeFileSync(baselinePath, BASELINE_FIXTURE);

		const saved = captureEnv(["OMP_SANDBOX_BASELINE_CONFIG"]);
		process.env.OMP_SANDBOX_BASELINE_CONFIG = baselinePath;
		let result: PrepareWorkspaceResult;
		try {
			result = await prepareWorkspace({
				workspaceId: "d1",
				workspaceRoot: volumeRoot,
				source: { local: source },
			});
		} finally {
			restoreEnv(saved);
		}

		expect(result.baselineSeed?.seeded).toBe(true);
		expect(result.baselineSeed?.source).toBe(baselinePath);

		const seededPath = join(volumeRoot, ".home", "agent", "config.yml");
		expect(existsSync(seededPath)).toBe(true);
		const parsed = YAML.parse(readFileSync(seededPath, "utf8")) as Record<string, unknown>;

		// Allowlisted keys survive, nested and top-level alike.
		expect(parsed.modelRoles).toEqual({ default: "default" });
		expect(parsed.enabledModels).toEqual(["opus", "haiku"]);
		expect(parsed.disabledProviders).toEqual(["openrouter"]);
		expect(parsed.temperature).toBe(0.4);
		expect(parsed.model).toEqual({ loopGuard: { maxIterations: 20 } });
		expect(parsed.tools).toEqual({ approval: { mode: "on-failure" }, approvalMode: "on-failure" });
		expect(parsed.bash).toEqual({ patterns: ["allowed/one", "allowed/two"] });
		expect(parsed.plan).toEqual({ defaultOnStartup: true });
		expect(parsed.memory).toEqual({ backend: "local" });

		// Non-allowlisted keys never cross.
		expect(parsed.credentials).toBeUndefined();
		expect(parsed.interpreter).toBeUndefined();
		expect(parsed.apiKey).toBeUndefined();

		// Sub-deny inside the allowlisted compaction prefix drops service-gated keys.
		expect(parsed.compaction).toEqual({ autoCompact: true });

		// The verified marker is still written after the seed.
		expect(
			JSON.parse(readFileSync(join(volumeRoot, ".omp-workspace-init.json"), "utf8")),
		).toMatchObject({
			workspaceId: "d1",
			source: { local: source },
			prepVersion: WORKSPACE_PREP_VERSION,
		});
		expect(result.marker.initializedAt).toBeTypeOf("number");
		expect(existsSync(join(volumeRoot, ".checkout", "readme.md"))).toBe(true);
	});

	test("sandboxEnvKeys drop unresolvable model roles and seed a sibling models.yml with rewritten keys", async () => {
		const source = await makeRepo(tempDir("omp-prep-src-"));
		const volumeRoot = tempDir("omp-prep-vol-");
		const baseline = tempDir("omp-prep-baseline-");
		const baselinePath = join(baseline, "config.yml");
		writeFileSync(
			baselinePath,
			`modelRoles:
  default: tokenrouter/kimi-k2.7-code
  legacy: ghost-provider/ghost-model
cycleOrder:
  - default
  - legacy
temperature: 0.4
`,
		);
		// Sibling provider definitions: seeding discovers models.yml beside
		// the pinned config.yml.
		writeFileSync(
			join(baseline, "models.yml"),
			`providers:
  tokenrouter:
    baseUrl: https://api.tokenrouter.example.com/v1
    apiKey: lit-test-key
`,
		);

		const saved = captureEnv(["OMP_SANDBOX_BASELINE_CONFIG"]);
		process.env.OMP_SANDBOX_BASELINE_CONFIG = baselinePath;
		let result: PrepareWorkspaceResult;
		try {
			result = await prepareWorkspace({
				workspaceId: "d4",
				workspaceRoot: volumeRoot,
				source: { local: source },
				sandboxEnvKeys: ["TOKENROUTER_API_KEY"],
			});
		} finally {
			restoreEnv(saved);
		}

		expect(result.baselineSeed?.seeded).toBe(true);
		expect(result.baselineSeed?.modelsSeeded).toBe(true);

		// config.yml: roles whose provider cannot resolve in the sandbox are
		// dropped, and the role-name cycleOrder follows the surviving roles.
		const seededPath = join(volumeRoot, ".home", "agent", "config.yml");
		const parsed = YAML.parse(readFileSync(seededPath, "utf8")) as Record<string, unknown>;
		expect(parsed.modelRoles).toEqual({ default: "tokenrouter/kimi-k2.7-code" });
		expect(parsed.cycleOrder).toEqual(["default"]);

		// models.yml: the literal provider credential is rewritten to the
		// env-name convention the sandbox must carry; never a literal secret.
		const modelsPath = join(volumeRoot, ".home", "agent", "models.yml");
		expect(existsSync(modelsPath)).toBe(true);
		const modelsText = readFileSync(modelsPath, "utf8");
		expect(modelsText.startsWith("# Seeded")).toBe(true);
		expect(modelsText).not.toContain("lit-test-key");
		const models = YAML.parse(modelsText) as {
			providers: Record<string, { baseUrl?: string; apiKey?: string }>;
		};
		expect(models.providers.tokenrouter.baseUrl).toBe("https://api.tokenrouter.example.com/v1");
		expect(models.providers.tokenrouter.apiKey).toBe("TOKENROUTER_API_KEY");
		expect(result.baselineSeed?.requiredEnvKeys).toContain("TOKENROUTER_API_KEY");
	});

	test("hand-edited seeded config survives re-prepare with reason exists", async () => {
		const source = await makeRepo(tempDir("omp-prep-src-"));
		const volumeRoot = tempDir("omp-prep-vol-");
		const baseline = tempDir("omp-prep-baseline-");
		const baselinePath = join(baseline, "config.yml");
		writeFileSync(
			baselinePath,
			`modelRoles:\n  default: default\ntemperature: 0.4\ncredentials:\n  apiKey: sk-abc123\n`,
		);

		const saved = captureEnv(["OMP_SANDBOX_BASELINE_CONFIG"]);
		process.env.OMP_SANDBOX_BASELINE_CONFIG = baselinePath;
		let first: PrepareWorkspaceResult;
		try {
			first = await prepareWorkspace({
				workspaceId: "d2",
				workspaceRoot: volumeRoot,
				source: { local: source },
			});
		} finally {
			restoreEnv(saved);
		}
		expect(first.baselineSeed?.seeded).toBe(true);

		// Hand-edit the seeded config the way a booted sandbox session would.
		const seededPath = join(volumeRoot, ".home", "agent", "config.yml");
		const handEdit = `modelRoles:\n  default: edited-by-hand\ntemperature: 0.9\n`;
		writeFileSync(seededPath, handEdit);

		const second = await prepareWorkspace({
			workspaceId: "d2",
			workspaceRoot: volumeRoot,
			source: { local: source },
		});
		expect(second.baselineSeed?.seeded).toBe(false);
		expect(second.baselineSeed?.reason).toBe("exists");
		expect(readFileSync(seededPath, "utf8")).toBe(handEdit);
	});

	test("no operator baseline source: preparation still succeeds, seed reports no-source", async () => {
		const source = await makeRepo(tempDir("omp-prep-src-"));
		const volumeRoot = tempDir("omp-prep-vol-");
		const emptyAgent = tempDir("omp-prep-noagent-");
		const emptyXdg = tempDir("omp-prep-noxdg-");
		const emptyHome = tempDir("omp-prep-nohome-");
		expect(existsSync(join(emptyHome, ".omp", "agent", "config.yml"))).toBe(false);

		const saved = captureEnv([
			"OMP_SANDBOX_BASELINE_CONFIG",
			"PI_CODING_AGENT_DIR",
			"XDG_DATA_HOME",
			"HOME",
		]);
		delete process.env.OMP_SANDBOX_BASELINE_CONFIG;
		process.env.PI_CODING_AGENT_DIR = emptyAgent;
		process.env.XDG_DATA_HOME = emptyXdg;
		process.env.HOME = emptyHome;
		let first: PrepareWorkspaceResult;
		let second: PrepareWorkspaceResult;
		try {
			first = await prepareWorkspace({
				workspaceId: "d3",
				workspaceRoot: volumeRoot,
				source: { local: source },
			});
			// The valid-marker early return also re-attempts the seed and
			// reports no-source; it must stay under the scrubbed env (a real
			// ~/.omp/agent on the dev machine would otherwise seed).
			second = await prepareWorkspace({
				workspaceId: "d3",
				workspaceRoot: volumeRoot,
				source: { local: source },
			});
		} finally {
			restoreEnv(saved);
		}

		expect(existsSync(join(volumeRoot, ".omp-workspace-init.json"))).toBe(true);
		if (first.baselineSeed !== undefined) {
			expect(first.baselineSeed.seeded).toBe(false);
			expect(first.baselineSeed.reason).toBe("no-source");
		}
		expect(existsSync(join(volumeRoot, ".home", "agent", "config.yml"))).toBe(false);
		expect(second.baselineSeed?.seeded).toBe(false);
		expect(second.baselineSeed?.reason).toBe("no-source");
	});
});
