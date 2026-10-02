import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { defaultDenyRoots, defaultRuntimeLaunch } from "../runtime-launch";
import { buildBwrapArgv, DeniedBindError, type BwrapArgsInput } from "#lib/runtime/bwrap-args";
import type { ProviderProfile } from "#lib/runtime/provider-protocol";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";

afterAll(cleanupTempDirs);

function file(path: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, "");
	return path;
}

function layout(kind: "source" | "bundle") {
	const root = realpathSync(tempDir("fleet-runtime-launch-"));
	const moduleDir =
		kind === "source" ? join(root, "apps", "fleet") : join(root, "dist-bundle", "providers");
	mkdirSync(moduleDir, { recursive: true });
	return { root, moduleDir };
}

function sandbox(kind: "source" | "bundle") {
	const fixture = layout(kind);
	file(join(fixture.root, "package.json"));
	file(
		kind === "source"
			? join(fixture.root, "apps", "session", "index.ts")
			: join(fixture.root, "dist-bundle", "cli.js"),
	);
	const operatorHome = join(fixture.root, "operator");
	const workspaceDir = join(fixture.root, "volumes", "checkout");
	const homeDir = join(fixture.root, "volumes", "home");
	for (const dir of [
		join(operatorHome, ".ssh"),
		join(operatorHome, ".omp-web"),
		workspaceDir,
		homeDir,
	]) {
		mkdirSync(dir, { recursive: true });
	}
	const sshAuthSock = file(join(operatorHome, ".ssh", "agent.sock"));
	const runtimeBin = file(join(fixture.root, "bin", "bun"));
	const env = { HOME: operatorHome, SSH_AUTH_SOCK: sshAuthSock, OMP_RUNTIME_BIN: runtimeBin };
	const launch = defaultRuntimeLaunch(env, fixture.moduleDir);
	const profile: ProviderProfile = {
		id: "scratch",
		provider: "bwrap",
		executable: join(fixture.moduleDir, "bwrap-provider"),
		tools: [],
	};
	const input: BwrapArgsInput = {
		workspaceDir,
		homeDir,
		profile,
		workspaceToken: "scratch-workspace-token",
		runtimeEntry: launch.entry,
		runtimeBin: launch.bin,
		runtimeArgs: launch.args,
		denyRoots: defaultDenyRoots(env, fixture.moduleDir),
		env,
	};
	return { ...fixture, operatorHome, sshAuthSock, env, input };
}

function expectDenied(input: BwrapArgsInput, source: string, root: string): void {
	let error: unknown;
	try {
		buildBwrapArgv(input);
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(DeniedBindError);
	expect(error).toMatchObject({ source: realpathSync(source), root });
}

function expectArgvSequence(argv: string[], sequence: string[]): void {
	const found = argv.some((_, index) =>
		sequence.every((value, offset) => argv[index + offset] === value),
	);
	expect(found).toBe(true);
}

describe("defaultRuntimeLaunch scratch layouts", () => {
	test("source fleet launches the sibling session source", () => {
		const { root, moduleDir } = layout("source");
		const entry = file(join(root, "apps", "session", "index.ts"));
		expect(defaultRuntimeLaunch({}, moduleDir)).toEqual({
			entry,
			bin: process.execPath,
			args: [],
		});
	});

	test("installed provider bundle launches cli.js with the session subcommand", () => {
		const { root, moduleDir } = layout("bundle");
		const entry = file(join(root, "dist-bundle", "cli.js"));
		expect(defaultRuntimeLaunch({}, moduleDir)).toEqual({
			entry,
			bin: process.execPath,
			args: ["session"],
		});
	});

	test("a nonempty entry override wins over every existing discovery candidate", () => {
		const { root, moduleDir } = layout("bundle");
		file(join(root, "dist-bundle", "session", "index.ts"));
		file(join(root, "apps", "session", "index.ts"));
		file(join(root, "dist-bundle", "cli.js"));
		const entry = join(root, "custom", "session.ts");
		expect(defaultRuntimeLaunch({ OMP_RUNTIME_ENTRY: entry }, moduleDir)).toEqual({
			entry,
			bin: process.execPath,
			args: [],
		});
	});

	test("a custom runtime binary is respected for discovered and overridden entries", () => {
		const { root, moduleDir } = layout("bundle");
		const bundle = file(join(root, "dist-bundle", "cli.js"));
		const bin = join(root, "custom", "bun");
		expect(defaultRuntimeLaunch({ OMP_RUNTIME_BIN: bin }, moduleDir)).toEqual({
			entry: bundle,
			bin,
			args: ["session"],
		});
		const entry = join(root, "custom", "session.ts");
		expect(
			defaultRuntimeLaunch({ OMP_RUNTIME_ENTRY: entry, OMP_RUNTIME_BIN: bin }, moduleDir),
		).toEqual({ entry, bin, args: [] });
	});

	test("an intentionally empty runtime binary is preserved in both launch branches", () => {
		const { root, moduleDir } = layout("source");
		const source = file(join(root, "apps", "session", "index.ts"));
		expect(defaultRuntimeLaunch({ OMP_RUNTIME_BIN: "" }, moduleDir)).toEqual({
			entry: source,
			bin: "",
			args: [],
		});
		const entry = join(root, "override.ts");
		expect(
			defaultRuntimeLaunch({ OMP_RUNTIME_ENTRY: entry, OMP_RUNTIME_BIN: "" }, moduleDir),
		).toEqual({ entry, bin: "", args: [] });
	});

	test("an empty entry override falls through to bundle discovery", () => {
		const { root, moduleDir } = layout("bundle");
		const entry = file(join(root, "dist-bundle", "cli.js"));
		expect(defaultRuntimeLaunch({ OMP_RUNTIME_ENTRY: "" }, moduleDir)).toEqual({
			entry,
			bin: process.execPath,
			args: ["session"],
		});
	});

	test("a missing layout returns the normalized first final development candidate", () => {
		const { root, moduleDir } = layout("source");
		const unnormalizedModuleDir = `${moduleDir}/../fleet/./`;
		expect(defaultRuntimeLaunch({}, unnormalizedModuleDir)).toEqual({
			entry: normalize(join(root, "apps", "session", "index.ts")),
			bin: process.execPath,
			args: [],
		});
	});

	test("the sibling session source takes precedence over the bundle", () => {
		const { root, moduleDir } = layout("source");
		const entry = file(join(root, "apps", "session", "index.ts"));
		file(join(root, "apps", "cli.js"));
		expect(defaultRuntimeLaunch({}, moduleDir)).toEqual({
			entry,
			bin: process.execPath,
			args: [],
		});
	});

	test("a provider bundle inside a checkout discovers apps/session before cli.js", () => {
		const { root, moduleDir } = layout("bundle");
		const entry = file(join(root, "apps", "session", "index.ts"));
		file(join(root, "dist-bundle", "cli.js"));
		expect(defaultRuntimeLaunch({}, moduleDir)).toEqual({
			entry,
			bin: process.execPath,
			args: [],
		});
	});
});

for (const kind of ["source", "bundle"] as const) {
	describe(`defaultDenyRoots ${kind} layout and sandbox policy`, () => {
		test("normalizes operator and physical app administration roots", () => {
			const fixture = sandbox(kind);
			const env = { ...fixture.env, HOME: `${fixture.operatorHome}/../operator/./` };
			const moduleDir = `${fixture.moduleDir}/./`;
			const roots = defaultDenyRoots(env, moduleDir);
			expect(roots).toMatchObject({
				operatorHome: fixture.operatorHome,
				sshDir: join(fixture.operatorHome, ".ssh"),
				fleetState: join(fixture.operatorHome, ".omp-web"),
				providerState: fixture.moduleDir,
				sshAuthSock: fixture.sshAuthSock,
			});
			const { argv } = buildBwrapArgv({ ...fixture.input, denyRoots: roots, env });
			for (const root of [
				roots.operatorHome,
				roots.sshDir,
				roots.fleetState,
				roots.providerState,
			]) {
				expectArgvSequence(argv, ["--tmpfs", root]);
			}
		});

		test("realpaths HOME, SSH, fleet state, and the explicit module directory aliases", () => {
			const fixture = layout(kind);
			const operatorHome = join(fixture.root, "operator");
			const sshDir = join(fixture.root, "ssh-state");
			const fleetState = join(fixture.root, "fleet-state");
			for (const dir of [operatorHome, sshDir, fleetState]) {
				mkdirSync(dir, { recursive: true });
			}
			symlinkSync(sshDir, join(operatorHome, ".ssh"));
			symlinkSync(fleetState, join(operatorHome, ".omp-web"));
			const homeAlias = join(fixture.root, "operator-alias");
			const moduleAlias = join(fixture.root, "provider-alias");
			symlinkSync(operatorHome, homeAlias);
			symlinkSync(fixture.moduleDir, moduleAlias);
			expect(defaultDenyRoots({ HOME: `${homeAlias}/./` }, `${moduleAlias}/./`)).toMatchObject({
				operatorHome,
				sshDir,
				fleetState,
				providerState: fixture.moduleDir,
				sshAuthSock: null,
			});
		});

		test("rejects a profile tool inside the app provider administration directory", () => {
			const fixture = sandbox(kind);
			const tool = file(join(fixture.moduleDir, "admin", "control"));
			expectDenied(
				{ ...fixture.input, profile: { ...fixture.input.profile, tools: [tool] } },
				tool,
				fixture.moduleDir,
			);
		});

		test("rejects a tool outside the app whose symlink targets provider administration", () => {
			const fixture = sandbox(kind);
			const target = file(join(fixture.moduleDir, "admin", "control"));
			const tool = join(fixture.root, "control-alias");
			symlinkSync(target, tool);
			expectDenied(
				{ ...fixture.input, profile: { ...fixture.input.profile, tools: [tool] } },
				tool,
				fixture.moduleDir,
			);
		});

		test("rejects a workspace checkout inside provider administration", () => {
			const fixture = sandbox(kind);
			const workspaceDir = join(fixture.moduleDir, "checkout");
			mkdirSync(workspaceDir);
			expectDenied({ ...fixture.input, workspaceDir }, workspaceDir, fixture.moduleDir);
		});

		test("rejects a private home alias that resolves inside provider administration", () => {
			const fixture = sandbox(kind);
			const target = join(fixture.moduleDir, "private-home");
			mkdirSync(target);
			const homeDir = join(fixture.root, "home-alias");
			symlinkSync(target, homeDir);
			expectDenied({ ...fixture.input, homeDir }, homeDir, fixture.moduleDir);
		});

		test("binds separate sanctioned volumes and executes the resolved session launch", () => {
			const fixture = sandbox(kind);
			const { argv, env } = buildBwrapArgv(fixture.input);
			expectArgvSequence(argv, ["--bind", fixture.input.homeDir, fixture.input.homeDir]);
			expectArgvSequence(argv, ["--bind", fixture.input.workspaceDir, fixture.input.workspaceDir]);
			expectArgvSequence(argv, ["--chdir", fixture.input.workspaceDir]);
			const entry =
				kind === "source"
					? join(fixture.root, "apps", "session", "index.ts")
					: join(fixture.root, "dist-bundle", "cli.js");
			const command = [
				"--",
				fixture.env.OMP_RUNTIME_BIN,
				entry,
				...(kind === "bundle" ? ["session"] : []),
				"--omp-workspace-token=scratch-workspace-token",
			];
			expect(argv.slice(-command.length)).toEqual(command);
			expect(env.HOME).toBe(fixture.input.homeDir);
			expect(env.OMP_WORKSPACE_DIR).toBe(fixture.input.workspaceDir);
			expect(env).not.toHaveProperty("SSH_AUTH_SOCK");
		});
	});
}
