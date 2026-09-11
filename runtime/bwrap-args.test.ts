/**
 * Denylist + argv-shape tests for the pure bwrap argv builder (P5.2).
 *
 * The denylist is the enforcement point of P5.5: operator credentials, the
 * SSH agent, container sockets, and fleet/provider administration state are
 * never mountable into a sandbox. Every profile `tools` bind source must
 * survive `assertAllowedSource`; a denied source throws DeniedBindError
 * before any argv is produced. The workspace volume (checkout + private
 * home) is the sanctioned sandbox content and binds freely.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProviderProfile } from "../shared/provider-protocol";
import { OMP_PROVIDER_PROTO } from "../shared/provider-protocol";
import {
	DeniedBindError,
	assertAllowedSource,
	assertWorkspaceVolume,
	buildBwrapArgv,
	deriveDenyRoots,
	existingDenyDirs,
	existingDenyFiles,
} from "./bwrap-args";

function tempRoot(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** Deny roots pointing at a synthetic operator home under the OS tmpdir. */
function syntheticRoots() {
	const operatorHome = tempRoot("bwrap-op-home-");
	const sshDir = join(operatorHome, ".ssh");
	const fleetState = join(operatorHome, ".omp-web");
	const providerState = join(operatorHome, "provider-state");
	const sshAuthSock = join(operatorHome, ".ssh", "agent.sock");
	mkdirSync(sshDir, { recursive: true });
	mkdirSync(fleetState, { recursive: true });
	mkdirSync(providerState, { recursive: true });
	writeFileSync(sshAuthSock, "");
	return { operatorHome, sshDir, fleetState, providerState, sshAuthSock };
}

function baseProfile(tools: string[]): ProviderProfile {
	return {
		id: "test",
		provider: "bwrap",
		executable: "/usr/bin/bwrap",
		tools,
	};
}

describe("deriveDenyRoots", () => {
	test("derives operator home, ssh dir, fleet state from HOME", () => {
		const roots = deriveDenyRoots({ HOME: "/home/op" });
		expect(roots.operatorHome).toBe("/home/op");
		expect(roots.sshDir).toBe("/home/op/.ssh");
		expect(roots.fleetState).toBe("/home/op/.omp-web");
		expect(roots.providerState.length).toBeGreaterThan(0);
	});

	test("captures SSH_AUTH_SOCK when exported", () => {
		const roots = deriveDenyRoots({ HOME: "/home/op", SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1" });
		expect(roots.sshAuthSock).toBe("/tmp/ssh-x/agent.1");
	});

	test("leaves sshAuthSock null when absent", () => {
		const roots = deriveDenyRoots({ HOME: "/home/op" });
		expect(roots.sshAuthSock).toBeNull();
	});
});

describe("assertAllowedSource denylist", () => {
	const r = syntheticRoots();
	const roots = {
		operatorHome: r.operatorHome,
		sshDir: r.sshDir,
		fleetState: r.fleetState,
		providerState: r.providerState,
		sshAuthSock: r.sshAuthSock,
		userRuntimeDir: null,
	};

	test("operator home itself is denied", () => {
		expect(() => assertAllowedSource(r.operatorHome, roots)).toThrow(DeniedBindError);
	});

	test("operator ssh dir contents are denied", () => {
		expect(() => assertAllowedSource(join(r.sshDir, "id_ed25519"), roots)).toThrow(DeniedBindError);
	});

	test("a dotfile directly in the operator home (e.g. .aws) is denied", () => {
		const aws = join(r.operatorHome, ".aws");
		mkdirSync(aws, { recursive: true });
		expect(() => assertAllowedSource(join(aws, "credentials"), roots)).toThrow(DeniedBindError);
	});

	test("fleet state contents are denied", () => {
		expect(() => assertAllowedSource(join(r.fleetState, "fleet-state.json"), roots)).toThrow(
			DeniedBindError,
		);
	});

	test("provider state contents are denied", () => {
		expect(() => assertAllowedSource(join(r.providerState, "secret.json"), roots)).toThrow(
			DeniedBindError,
		);
	});

	test("the ssh-agent socket itself is denied", () => {
		expect(() => assertAllowedSource(r.sshAuthSock, roots)).toThrow(DeniedBindError);
	});

	test("docker/podman/containerd sockets are denied", () => {
		for (const sock of [
			"/var/run/docker.sock",
			"/run/docker.sock",
			"/run/podman/podman.sock",
			"/run/containerd/containerd.sock",
		]) {
			expect(() => assertAllowedSource(sock, roots)).toThrow(DeniedBindError);
		}
	});

	test("a relative tool path is denied (never bindable)", () => {
		expect(() => assertAllowedSource("relative/tool", roots)).toThrow(DeniedBindError);
	});
});

describe("assertWorkspaceVolume", () => {
	const r = syntheticRoots();
	const roots = {
		operatorHome: r.operatorHome,
		sshDir: r.sshDir,
		fleetState: r.fleetState,
		providerState: r.providerState,
		sshAuthSock: r.sshAuthSock,
		userRuntimeDir: null,
	};

	test("a volume under the fleet workspace root is allowed", () => {
		// Default fleet layout: ~/.omp-web/workspaces/<id>/.checkout + .home.
		const volume = join(r.fleetState, "workspaces", "d1");
		expect(() => assertWorkspaceVolume(join(volume, ".checkout"), roots)).not.toThrow();
		expect(() => assertWorkspaceVolume(join(volume, ".home"), roots)).not.toThrow();
	});

	test("a volume aliasing operator ssh state is denied", () => {
		expect(() => assertWorkspaceVolume(r.sshDir, roots)).toThrow(DeniedBindError);
		expect(() => assertWorkspaceVolume(join(r.sshDir, "id_ed25519"), roots)).toThrow(
			DeniedBindError,
		);
	});

	test("a volume inside provider state is denied", () => {
		expect(() => assertWorkspaceVolume(join(r.providerState, "x"), roots)).toThrow(DeniedBindError);
	});

	test("buildBwrapArgv rejects a workspaceDir under .ssh", () => {
		const r2 = syntheticRoots();
		const roots2 = {
			operatorHome: r2.operatorHome,
			sshDir: r2.sshDir,
			fleetState: r2.fleetState,
			providerState: r2.providerState,
			sshAuthSock: r2.sshAuthSock,
			userRuntimeDir: null,
		};
		const profile = baseProfile([]);
		expect(() =>
			buildBwrapArgv({
				workspaceDir: r2.sshDir,
				homeDir: tempRoot("bwrap-home-"),
				profile,
				workspaceToken: "tok",
				runtimeBin: "/usr/bin/bun",
				runtimeEntry: "/usr/bin/bun",
				denyRoots: roots2,
				env: {},
			}),
		).toThrow(DeniedBindError);
	});
});

describe("buildBwrapArgv", () => {
	test("denied tools throw before any argv is produced", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const r = syntheticRoots();
		const roots = {
			operatorHome: r.operatorHome,
			sshDir: r.sshDir,
			fleetState: r.fleetState,
			providerState: r.providerState,
			sshAuthSock: r.sshAuthSock,
			userRuntimeDir: null,
		};
		const profile = baseProfile([join(r.sshDir, "id_ed25519")]);
		expect(() =>
			buildBwrapArgv({
				workspaceDir: ws,
				homeDir: home,
				profile,
				workspaceToken: "tok",
				runtimeBin: "/usr/bin/bun",
				runtimeEntry: "/usr/bin/bun",
				denyRoots: roots,
			}),
		).toThrow(DeniedBindError);
	});

	test("workspace volume binds freely regardless of denylist", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		const { argv, env } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok-123",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {},
		});
		// Private home binds rw at its own path; checkout at its own path.
		expect(argv).toContain("--bind");
		const bindIx = argv.indexOf("--bind");
		expect(argv[bindIx + 1]).toBe(home);
		expect(argv[bindIx + 2]).toBe(home);
		expect(argv).toContain(ws);
		expect(env.HOME).toBe(home);
	});

	test("argv carries the frozen namespace shape", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		const { argv } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok-abc",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {},
		});
		expect(argv[0]).toBe("bwrap");
		// Allowlist policy: no whole-root bind; system roots are ro-bound
		// individually (existence-gated, realpath-deduped).
		expect(argv).not.toContain("--ro-bind /");
		// Every ro-bind source is inside an allowlisted system root, an /etc
		// entry, or is the deny-mask /dev/null. The builder mounts realpaths
		// (NixOS /etc entries resolve into /nix/store or /run), so the check
		// accepts any source under a credential-free system root.
		const roSources = argv.flatMap((v, i, a) => (v === "--ro-bind" ? [a[i + 1]] : []));
		for (const src of roSources) {
			expect(
				src === "/dev/null" ||
					["/nix/store", "/run", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc"].some(
						(root) => src === root || src.startsWith(root + "/"),
					),
			).toBe(true);
		}
		expect(argv).toContain("--dev");
		expect(argv).toContain("--proc");
		expect(argv).toContain("--tmpfs");
		expect(argv).toContain("--unshare-all");
		expect(argv).toContain("--die-with-parent");
		expect(argv).toContain("--new-session");
		expect(argv).toContain("--chdir");
		// Runtime entry with identity token as the final argument.
		expect(argv[argv.length - 1]).toBe("--omp-workspace-token=tok-abc");
		expect(argv[argv.length - 2]).toBe("/usr/bin/bun");
	});

	test('network knob (P5.7): absent and "isolated" keep the frozen argv (no --share-net)', () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const run = (profile: ProviderProfile) =>
			buildBwrapArgv({
				workspaceDir: ws,
				homeDir: home,
				profile,
				workspaceToken: "tok-net",
				runtimeBin: "/usr/bin/bun",
				runtimeEntry: "/usr/bin/bun",
				env: {},
			}).argv;
		const absent = run(baseProfile([]));
		const isolated = run({ ...baseProfile([]), network: "isolated" });
		// Absent is byte-for-byte the historic argv: no --share-net anywhere.
		expect(absent).not.toContain("--share-net");
		expect(isolated).not.toContain("--share-net");
		// Both still isolate the full namespace set.
		for (const argv of [absent, isolated]) {
			expect(argv).toContain("--unshare-all");
			expect(argv).toContain("--die-with-parent");
			expect(argv).toContain("--new-session");
		}
	});

	test('network knob (P5.7): "host" shares ONLY the netns after --unshare-all', () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const { argv } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile: { ...baseProfile([]), network: "host" },
			workspaceToken: "tok-net",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {},
		});
		// --share-net lands after --unshare-all (flag order is the swap:
		// bwrap applies namespace flags in order) and before the "--" argv
		// terminator; pid/user/ipc isolation stays intact.
		expect(argv).toContain("--share-net");
		const unshareIx = argv.indexOf("--unshare-all");
		const shareIx = argv.indexOf("--share-net");
		const terminatorIx = argv.indexOf("--");
		expect(shareIx).toBeGreaterThan(unshareIx);
		expect(shareIx).toBeLessThan(terminatorIx);
		expect(argv).toContain("--die-with-parent");
		expect(argv).toContain("--new-session");
		expect(argv[argv.length - 1]).toBe("--omp-workspace-token=tok-net");
	});

	test("profile tools are ro-bound after the workspace binds", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const tool = "/usr/bin/git";
		const profile = baseProfile([tool]);
		const { argv } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {},
		});
		const toolIx = argv.indexOf(tool);
		expect(toolIx).toBeGreaterThan(-1);
		expect(argv[toolIx - 1]).toBe("--ro-bind");
	});

	test("existing deny roots are masked with tmpfs (never readable)", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const r = syntheticRoots();
		const roots = {
			operatorHome: r.operatorHome,
			sshDir: r.sshDir,
			fleetState: r.fleetState,
			providerState: r.providerState,
			sshAuthSock: r.sshAuthSock,
			userRuntimeDir: null,
		};
		const profile = baseProfile([]);
		const { argv } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			denyRoots: roots,
			env: {},
		});
		const tmpfsTargets = argv.flatMap((v, i, a) => (v === "--tmpfs" ? [a[i + 1]] : []));
		expect(tmpfsTargets).toContain(r.operatorHome);
		expect(tmpfsTargets).toContain(r.sshDir);
		expect(tmpfsTargets).toContain(r.fleetState);
		expect(tmpfsTargets).toContain(r.providerState);
		// The agent socket file (syntheticRoots creates it) is masked via /dev/null.
		const nullTargets = argv.flatMap((v, i, a) => (v === "/dev/null" ? [a[i + 1]] : []));
		expect(nullTargets).toContain(r.sshAuthSock);
	});

	test("env whitelist excludes operator secrets", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		const { env } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {
				HOME: "/home/op",
				SSH_AUTH_SOCK: "/tmp/ssh-x/agent.1",
				OMP_FLEET_STATE: "/home/op/.omp-web",
				PATH: "/usr/bin",
				LANG: "en_US.UTF-8",
				PI_CODING_AGENT_DIR: "/leak",
			},
		});
		expect(env.SSH_AUTH_SOCK).toBeUndefined();
		expect(env.OMP_FLEET_STATE).toBeUndefined();
		expect(env.LANG).toBe("en_US.UTF-8");
		expect(env.HOME).toBe(home);
		expect(env.PI_CODING_AGENT_DIR).toBe(join(home, "agent"));
		expect(env.OMP_PROVIDER_PROTO).toBe(String(OMP_PROVIDER_PROTO));
	});

	test("OMP_SESSION_CALLBACK_* enrollment keys pass the allowlist", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		const { env } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {
				OMP_SESSION_CALLBACK_URL: "https://fleet.example/callback/up",
				OMP_SESSION_CALLBACK_WORKSPACE: "d1",
				OMP_SESSION_CALLBACK_GENERATION: "3",
				OMP_SESSION_CALLBACK_TOKEN: "secret-256-bit-enrollment",
				OMP_SESSION_CALLBACK_PROXY: "http://proxy:3128",
				OMP_SESSION_CALLBACK_ALLOW_HTTP: "1",
			},
		});
		expect(env.OMP_SESSION_CALLBACK_URL).toBe("https://fleet.example/callback/up");
		expect(env.OMP_SESSION_CALLBACK_WORKSPACE).toBe("d1");
		expect(env.OMP_SESSION_CALLBACK_GENERATION).toBe("3");
		expect(env.OMP_SESSION_CALLBACK_TOKEN).toBe("secret-256-bit-enrollment");
		expect(env.OMP_SESSION_CALLBACK_PROXY).toBe("http://proxy:3128");
		expect(env.OMP_SESSION_CALLBACK_ALLOW_HTTP).toBe("1");
	});

	test("ambient resume-required is dropped; the validated handoff supplies it", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		const base = {
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
		};
		const resumePath = "/workspace/.home/agent/sessions/s1/main.jsonl";

		// The provider process may itself export the required-resume flag (for
		// example through an operator shell). As an ambient allowlist key it
		// would force every sandbox to resume a target that may not exist,
		// failing startup, so it is handoff-only.
		const ambient = buildBwrapArgv({
			...base,
			env: { OMP_SESSION_RESUME: resumePath, OMP_SESSION_RESUME_REQUIRED: "1" },
		}).env;
		expect(ambient.OMP_SESSION_RESUME).toBe(resumePath);
		expect(ambient.OMP_SESSION_RESUME_REQUIRED).toBeUndefined();

		// callbackEnv carries the values validated from the handoff file.
		const handoff = buildBwrapArgv({
			...base,
			env: {},
			callbackEnv: { OMP_SESSION_RESUME: resumePath, OMP_SESSION_RESUME_REQUIRED: "1" },
		}).env;
		expect(handoff.OMP_SESSION_RESUME).toBe(resumePath);
		expect(handoff.OMP_SESSION_RESUME_REQUIRED).toBe("1");

		// Handoff-only must not un-reserve the key: a profile secretRef still
		// cannot shadow it.
		expect(() =>
			buildBwrapArgv({ ...base, env: {}, secretEnv: { OMP_SESSION_RESUME_REQUIRED: "0" } }),
		).toThrow();
	});

	test("stale non-SESSION callback keys never pass the allowlist", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		const { env } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {
				OMP_CALLBACK_URL: "https://leak.example/up",
				OMP_CALLBACK_TOKEN: "leak",
				OMP_ENROLLMENT: "leak",
			},
		});
		expect(env.OMP_CALLBACK_URL).toBeUndefined();
		expect(env.OMP_CALLBACK_TOKEN).toBeUndefined();
		expect(env.OMP_ENROLLMENT).toBeUndefined();
	});

	test("credential-shaped ambient keys never pass (secretRefs only)", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		const { env } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {
				PI_AUTH_BROKER: "https://broker.example",
				PI_AUTH_NO_BORROW: "1",
				PI_PROFILE: "prod-model",
				PI_CONFIG_DIR: "/home/op/.pi",
				PI_EXPORT: "export-token",
				PI_SESSION_ID: "sess-1",
			},
		});
		// Model-credential keys leave the ambient allowlist: they enter ONLY
		// via resolved profile.secretRefs (secretEnv), never from the
		// operator environment.
		expect(env.PI_AUTH_BROKER).toBeUndefined();
		expect(env.PI_AUTH_NO_BORROW).toBeUndefined();
		expect(env.PI_PROFILE).toBeUndefined();
		expect(env.PI_CONFIG_DIR).toBeUndefined();
		// Non-credential PI keys stay ambient-allowlisted.
		expect(env.PI_EXPORT).toBe("export-token");
		expect(env.PI_SESSION_ID).toBe("sess-1");
	});

	test("secretEnv injects only the resolved refs, overriding nothing allowlisted", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		const { env } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: { MODEL_CRED: "operator-leak" },
			secretEnv: { MODEL_CRED: "resolved-model-secret" },
		});
		expect(env.MODEL_CRED).toBe("resolved-model-secret");
	});

	test("secretEnv cannot override a reserved sandbox key", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const profile = baseProfile([]);
		expect(() =>
			buildBwrapArgv({
				workspaceDir: ws,
				homeDir: home,
				profile,
				workspaceToken: "tok",
				runtimeBin: "/usr/bin/bun",
				runtimeEntry: "/usr/bin/bun",
				env: {},
				secretEnv: { HOME: "/evil" },
			}),
		).toThrow();
	});

	test("sourceLocal is masked when distinct from the workspace volumes", () => {
		const ws = tempRoot("bwrap-ws-");
		const home = tempRoot("bwrap-home-");
		const source = tempRoot("bwrap-src-");
		const profile = baseProfile([]);
		const { argv } = buildBwrapArgv({
			workspaceDir: ws,
			homeDir: home,
			profile,
			workspaceToken: "tok",
			runtimeBin: "/usr/bin/bun",
			runtimeEntry: "/usr/bin/bun",
			env: {},
			sourceLocal: source,
		});
		const tmpfsTargets = argv.flatMap((v, i, a) => (v === "--tmpfs" ? [a[i + 1]] : []));
		expect(tmpfsTargets).toContain(source);
	});
});

describe("existingDenyDirs / existingDenyFiles", () => {
	test("existing directories are masked with tmpfs", () => {
		const r = syntheticRoots();
		const roots = {
			operatorHome: r.operatorHome,
			sshDir: r.sshDir,
			fleetState: r.fleetState,
			providerState: r.providerState,
			sshAuthSock: r.sshAuthSock,
			userRuntimeDir: null,
		};
		const dirs = existingDenyDirs(roots);
		expect(dirs).toContain(r.operatorHome);
		expect(dirs).toContain(r.sshDir);
		expect(dirs).toContain(r.fleetState);
		expect(dirs).toContain(r.providerState);
		// A nonexistent directory is not masked (bwrap cannot mkdir under ro /).
		const ghostDirs = existingDenyDirs({
			operatorHome: r.operatorHome,
			sshDir: join(r.operatorHome, "ghost-dir"),
			fleetState: r.fleetState,
			providerState: r.providerState,
			sshAuthSock: null,
			userRuntimeDir: null,
		});
		expect(ghostDirs).not.toContain(join(r.operatorHome, "ghost-dir"));
	});

	test("existing socket files are masked by /dev/null ro-bind", () => {
		const r = syntheticRoots();
		const sockFile = join(r.operatorHome, "agent.sock");
		writeFileSync(sockFile, "");
		const roots = {
			operatorHome: r.operatorHome,
			sshDir: r.sshDir,
			fleetState: r.fleetState,
			providerState: r.providerState,
			sshAuthSock: sockFile,
			userRuntimeDir: null,
		};
		const files = existingDenyFiles(roots);
		expect(files).toContain(sockFile);
		// The operator home dir itself is not a file mask.
		expect(files).not.toContain(r.operatorHome);
	});
});
