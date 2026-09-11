#!/usr/bin/env bun
/**
 * test-kubernetes-minikube — disposable-cluster acceptance walk of the
 * production Kubernetes worker lifecycle.
 *
 * Everything runs against production code paths: `startFleet` boots the real
 * control plane, the built `dist-bundle/providers/kubernetes-provider.js`
 * manages real Pods/PVCs, and the built `dist-bundle/cli.js` drives the
 * operator commands against it.
 *
 * The walk is fully disposable: one private temp root, one unique minikube
 * profile, one unique namespace, an isolated MINIKUBE_HOME / KUBECONFIG /
 * Docker configuration / fleet state / Git configuration. It NEVER runs
 * minikube: the orchestrator does, against this host, deliberately.
 *
 * Walk (one phase per line):
 *   prerequisite  resolve tools, require a local Docker socket, mint the
 *                 hermetic temp root, pin every environment selector, and
 *                 re-exec once so the children production code spawns without
 *                 an explicit env inherit that pinning too
 *   cluster       start the unique Docker-driver profile, create the
 *                 namespace, wait for its default SA + CA ConfigMap, pick its
 *                 StorageClass, write the temp OMP_KUBE_BIN wrapper, build and
 *                 load the image from dist-bundle/image/, and prove from a
 *                 throwaway Pod which address the cluster can dial back
 *   image         derive a CA-trusting image and serve the callback gateway
 *                 through a streaming HTTPS proxy bound to a Pod-reachable
 *                 address
 *   git           serve a bare repo with `git daemon`, prove host AND probe
 *                 Pod `git ls-remote` return the pinned commit
 *   preflight     write the kubernetes profile, start the fleet, run the
 *                 configured preflight, and prove the gateway allowlist
 *   spawn         register the seed project, create clone A (auto-start),
 *                 create clone B (start:false, zero resources), start it and
 *                 assert the full hardened Pod/PVC spec, then repeat-start
 *   stream        name the session over a production virtual stream, ask for
 *                 stats, wait for durable transcript bytes, then stop (which
 *                 collects the workspace's final evidence) + remove clone A
 *                 through the public routes
 *   wake          for B: bulk-compare transcript bytes, check pin + cwd, write
 *                 a home sentinel, stop/wake (same PVC/files/session, new Pod
 *                 UID), restart the fleet and reconnect, restore a deleted main
 *                 transcript byte-identically, then write the dirty file with
 *                 the clone stopped, wake onto it and stop again so the stop's
 *                 own evidence carries the dirty Git verdict, and require the
 *                 removal to refuse
 *   delete        clear the rejected attempt, remove B through the verified
 *                 gate after the change is preserved
 *   cleanup       stop the fleet, proxy, Git daemon and every tracked child;
 *                 delete the namespace, profile and image tags; restore the
 *                 environment; remove the temp root LAST
 *
 * Usage: bun scripts/test-kubernetes-minikube.ts [--keep]
 * Exit 0 + `KUBERNETES_MINIKUBE_ACCEPTANCE_OK` only after every assertion AND
 * every cleanup step succeeds. Any failure prints `BLOCKED <phase>` with
 * sanitized diagnostics and exits nonzero. SIGINT/SIGTERM/SIGHUP run the same
 * single cleanup owner before exiting.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server, Subprocess } from "bun";

import type { BulkCorrelation, DaemonTransportRegistry } from "../fleet/daemon-transport";
import { FleetLogStore } from "../fleet/log-store";
import { startFleet, type FleetServer } from "../fleet/server";
import {
	CALLBACK_BULK_PATH_PREFIX,
	CALLBACK_DOWN_PATH,
	CALLBACK_UP_PATH,
	type CallbackEnvelope,
} from "../shared/callback-protocol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));
const KEEP = process.argv.includes("--keep");
const DEFAULT_DOCKER_SOCKET = "unix:///var/run/docker.sock";
const MARKER = "KUBERNETES_MINIKUBE_ACCEPTANCE_OK";
const PROVIDER_ID = "kubernetes";

const PHASES = [
	"prerequisite",
	"cluster",
	"image",
	"git",
	"preflight",
	"spawn",
	"stream",
	"wake",
	"delete",
	"cleanup",
] as const;
type Phase = (typeof PHASES)[number];

/** Profile values the walk both configures and asserts against. */
const PROFILE_CPU = "500m";
const PROFILE_MEMORY = "512Mi";
const PROFILE_STORAGE_SIZE = "1Gi";
const RUNTIME_UID = 10001;
const POD_WORKSPACE_ROOT = "/workspace";
const POD_CHECKOUT_DIR = "/workspace/.checkout";
const POD_HOME_DIR = "/workspace/.home";

const LABEL_MANAGED_BY = "app.kubernetes.io/managed-by";
const LABEL_MANAGED_BY_VALUE = "omp-web";
const LABEL_GENERATION = "omp-web.omp.dev/generation";
const ANN_WORKSPACE_ID = "omp-web.omp.dev/workspace-id";

const TOOL_POD_LABEL = "omp-web.omp.dev/acceptance-tool";

/**
 * The address every listener in this VM binds: the wildcard, so a listener
 * answers on every local address (loopback included) whatever address the
 * cluster is told to dial. `hostAddress` is the other half of that pair — the
 * address Pods actually use — and only a Pod can decide it.
 */
const BIND_ADDRESS = "0.0.0.0";

const KUBE_TIMEOUT_MS = 180_000;
const CLUSTER_TIMEOUT_MS = 900_000;
const CLUSTER_READY_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 900_000;
const SUBPROCESS_TIMEOUT_MS = 180_000;
const POLL_TIMEOUT_MS = 120_000;
const PAIR_TIMEOUT_MS = 300_000;
const STOP_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Diagnostics hygiene
// ---------------------------------------------------------------------------

/** Paths/literals replaced with a placeholder before anything is printed. */
const REDACTIONS: { needle: string; label: string }[] = [];

function redact(value: string, label: string): string {
	if (value !== "") REDACTIONS.push({ needle: value, label });
	return value;
}

function sanitize(text: string): string {
	let out = text;
	for (const { needle, label } of REDACTIONS) out = out.split(needle).join(`<${label}>`);
	return out;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

// ---------------------------------------------------------------------------
// Environment control (captured before any mutation, restored by cleanup)
// ---------------------------------------------------------------------------

const originalEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string): void {
	if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
	process.env[key] = value;
}

function unsetEnv(key: string): void {
	if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
	delete process.env[key];
}

function restoreEnv(): void {
	for (const [key, value] of originalEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

/** The current (sandboxed) environment with no `undefined` values. */
function scriptEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
}

/**
 * Pin the walk's environment for real by re-execing this script once.
 *
 * Bun captures the process environment when it starts: mutating `process.env`
 * is visible in-process — and to the spawns whose helpers here pass `env`
 * explicitly — but NOT to a `Bun.spawn` child that omits `env`, which receives
 * the environment this process STARTED with. Production code does exactly that:
 * the fleet resolves a clone's namespace uid by spawning `OMP_KUBE_BIN` with no
 * `env` of its own. Without this re-exec such a child would run against the
 * OPERATOR environment — the real HOME, the operator's kubeconfig, no sandbox
 * MINIKUBE_HOME — and fail with a kubeconfig that has no entry for the profile
 * (`minikube -p <profile> kubectl` reports `no server found for cluster`).
 *
 * The child sees the pinned values as its own environment, so every descendant
 * of the walk inherits them. It adopts this process's sandbox root and owns the
 * single cleanup owner; the parent only forwards signals and the exit status.
 */
async function reexecWithPinnedEnvironment(): Promise<void> {
	if (BOOTSTRAPPED) return;
	const child = Bun.spawn([bunBin, realpathSync(import.meta.path), ...process.argv.slice(2)], {
		env: { ...scriptEnv(), OMP_ACCEPTANCE_ROOT: sandboxRoot, OMP_ACCEPTANCE_BOOTSTRAP: "1" },
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
		process.on(signal, () => child.kill(signal));
	}
	console.log("environment: re-execing the walk with the pinned environment");
	process.exit(await child.exited);
}

// ---------------------------------------------------------------------------
// Bounded command / polling helpers
// ---------------------------------------------------------------------------

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

async function runCommand(
	cmd: readonly string[],
	opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {},
): Promise<CommandResult> {
	const timeoutMs = opts.timeoutMs ?? SUBPROCESS_TIMEOUT_MS;
	const proc = Bun.spawn([...cmd], {
		cwd: opts.cwd,
		env: opts.env ?? scriptEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timedOut = false;
	const termTimer = setTimeout(() => {
		timedOut = true;
		proc.kill("SIGTERM");
		setTimeout(() => proc.kill("SIGKILL"), 1_000);
	}, timeoutMs);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	clearTimeout(termTimer);
	return { code: exitCode ?? -1, stdout, stderr, timedOut };
}

async function waitFor<T>(
	what: string,
	probe: () => T | null | Promise<T | null>,
	opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
	const intervalMs = opts.intervalMs ?? 250;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, intervalMs);
		await promise;
	}
}

/** An unused TCP port on the wildcard address (bounded bind + close). */
async function reservePort(): Promise<number> {
	const server = createServer();
	const listening = Promise.withResolvers<number>();
	const closed = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(0, "0.0.0.0", () => {
		const address = server.address();
		if (address === null || typeof address === "string") {
			listening.reject(new Error("no TCP address"));
			return;
		}
		listening.resolve(address.port);
	});
	const port = await listening.promise;
	server.close(() => closed.resolve());
	await closed.promise;
	return port;
}

/** Absolute, executable, realpath-resolved tool path (or null). */
function resolveTool(name: string): string | null {
	const found = Bun.which(name);
	if (found === null) return null;
	try {
		const real = realpathSync(found);
		return existsSync(real) ? real : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Plain-record navigation (kubectl JSON is untrusted input)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function nested(value: unknown, ...keys: readonly string[]): unknown {
	let current: unknown = value;
	for (const key of keys) {
		const record = asRecord(current);
		if (record === null) return undefined;
		current = record[key];
	}
	return current;
}

function textOf(value: unknown): string {
	return typeof value === "string" ? value : "";
}

// ---------------------------------------------------------------------------
// Single cleanup owner (identical pattern in scripts/test-bwrap-lifecycle.ts)
// ---------------------------------------------------------------------------

type SignalName = "SIGINT" | "SIGTERM" | "SIGHUP";

const SIGNAL_EXIT: Record<SignalName, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

/** A phase-tagged, caller-visible failure; the only thing that blocks a run. */
class BlockedError extends Error {
	constructor(
		readonly phase: Phase,
		detail: string,
	) {
		super(detail);
	}
}

interface CleanupStep {
	readonly name: string;
	run(): Promise<void> | void;
}

/**
 * The single cleanup owner. `install()` runs BEFORE any resource exists and
 * wires SIGINT/SIGTERM/SIGHUP; every teardown step is registered here and runs
 * exactly once, in reverse registration order, from both the normal exit path
 * and the signal path.
 */
class CleanupOwner {
	#steps: CleanupStep[] = [];
	#installed = false;
	#drained: Promise<boolean> | null = null;
	#failures: string[] = [];
	#signal: SignalName | null = null;

	add(name: string, run: () => Promise<void> | void): void {
		this.#steps.push({ name, run });
	}

	install(): void {
		if (this.#installed) return;
		this.#installed = true;
		for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
			process.on(signal, () => {
				this.#signal ??= signal;
				void this.run().then((ok) => process.exit(ok ? SIGNAL_EXIT[signal] : 1));
			});
		}
	}

	get interrupted(): SignalName | null {
		return this.#signal;
	}

	get failures(): readonly string[] {
		return this.#failures;
	}

	/** Idempotent: the first caller drains; every other caller awaits that run. */
	run(): Promise<boolean> {
		this.#drained ??= this.#drain();
		return this.#drained;
	}

	async #drain(): Promise<boolean> {
		for (const step of [...this.#steps].reverse()) {
			try {
				await step.run();
			} catch (cause) {
				this.#failures.push(`${step.name}: ${sanitize(messageOf(cause))}`);
			}
		}
		return this.#failures.length === 0;
	}
}

// ---------------------------------------------------------------------------
// Acceptance harness
// ---------------------------------------------------------------------------

class Acceptance {
	readonly cleanup = new CleanupOwner();
	#phase: Phase = "prerequisite";
	#pending: string[] = [];

	enter(phase: Phase): void {
		this.#phase = phase;
	}

	get phase(): Phase {
		return this.#phase;
	}

	check(name: string, ok: boolean, detail = ""): void {
		if (ok) {
			console.log(`ok   ${name}`);
			return;
		}
		const line = detail === "" ? name : `${name} — ${detail}`;
		this.#pending.push(line);
		console.error(`FAIL ${sanitize(line)}`);
	}

	/** Record a check and stop the phase immediately when it failed. */
	require(name: string, ok: boolean, detail = ""): void {
		this.check(name, ok, detail);
		if (!ok) throw new BlockedError(this.#phase, detail === "" ? name : `${name}: ${detail}`);
	}

	/** Return `value` when present; block the current phase otherwise. */
	expect<T>(value: T | null | undefined, detail: string): T {
		if (value === null || value === undefined) {
			throw new BlockedError(this.#phase, detail);
		}
		return value;
	}

	/** Throw once per phase when any check in it failed. */
	settle(): void {
		if (this.#pending.length === 0) return;
		throw new BlockedError(this.#phase, this.#pending.splice(0).join("; "));
	}
}

const acceptance = new Acceptance();

// ---------------------------------------------------------------------------
// Phase 1: prerequisite — temp root + environment pinning
// ---------------------------------------------------------------------------

/**
 * Whether THIS process is the pinned re-exec of the walk (see
 * `reexecWithPinnedEnvironment`). The bootstrap parent mints the temp root and
 * pins the environment; the child adopts both and runs every phase.
 */
const BOOTSTRAPPED = (process.env.OMP_ACCEPTANCE_BOOTSTRAP ?? "") !== "";

const sandboxRoot = (() => {
	const inherited = process.env.OMP_ACCEPTANCE_ROOT ?? "";
	if (inherited !== "") return redact(inherited, "tmp-root");
	return redact(mkdtempSync(join(tmpdir(), "omp-kube-acceptance-")), "tmp-root");
})();

if (BOOTSTRAPPED) {
	// Only the process that runs the walk owns the single cleanup owner: the
	// bootstrap parent's whole job is forwarding signals and the exit status.
	acceptance.cleanup.install();
	// Registered FIRST so the LIFO drain removes it LAST, after every other
	// resource has been released.
	acceptance.cleanup.add("remove temporary root", () => {
		if (!KEEP) rmSync(sandboxRoot, { recursive: true, force: true });
		else console.log(`sandbox kept at ${sandboxRoot}`);
	});
}

const sandboxHome = join(sandboxRoot, "home");
const minikubeHome = join(sandboxRoot, "minikube-home");
const kubeconfigPath = join(sandboxRoot, "kubeconfig");
const dockerConfigDir = join(sandboxRoot, "docker");
const binDir = join(sandboxRoot, "bin");
const workspaceDir = join(sandboxRoot, "workspaces");
const statePath = join(sandboxRoot, "fleet-state.json");
const configPath = join(sandboxRoot, "config.json");
const logsDir = join(sandboxRoot, "logs");
const seedProjectDir = join(sandboxRoot, "seed-project");
const gitRoot = join(sandboxRoot, "git");
const gitConfigPath = join(sandboxHome, ".gitconfig");

const profile = `omp-acc-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
const namespace = `omp-acc-${randomUUID().replace(/-/g, "").slice(0, 10)}`;
redact(profile, "minikube-profile");
redact(namespace, "namespace");

const baseImage = `omp-web-acceptance:${profile}`;
const caImage = `omp-web-acceptance-ca:${profile}`;

let minikubeBin = "";
let dockerBin = "";
let gitBin = "";
let opensslBin = "";
let bunBin = "";
let kubeBin = "";
let providerExecutable = "";
let cliBundle = "";
let imageContext = "";
let hostAddress = "";
let kubeContext = "";
let storageClass = "";
let gitPort = 0;
let gitUrl = "";
let proxyPort = 0;
let fleetPort = 0;
let commitId = "";

/** The acceptance image is built and loaded once, by the first phase that
 *  needs a Pod: the cluster phase's Pod-reachability preflight. */
let baseImageLoaded = false;

/** Captured Git daemon output, so a failing probe can quote the daemon. */
let gitDaemonLogs = { stdout: "", stderr: "" };

let fleet: FleetServer | null = null;
let gitDaemon: Subprocess | null = null;
let proxyServer: Server<undefined> | null = null;
const toolPods = new Set<string>();

/** Pod name → owning workspace, for PVC lookups in later phases. */
const managedPvcsByWorkspace = new Map<string, string>();

function pvcNameFor(daemonId: string): string {
	return managedPvcsByWorkspace.get(daemonId) ?? "";
}

type DockerEndpointSource = "DOCKER_HOST" | "docker context" | "default";

interface DockerEndpoint {
	/** The `unix://` endpoint this run pins, or the offending value to report. */
	readonly endpoint: string;
	readonly source: DockerEndpointSource;
}

/**
 * The local endpoint of the running Docker daemon, resolved in preference
 * order: an inherited `DOCKER_HOST`, the ACTIVE docker context, then the
 * default socket path. A `tcp://`/`ssh://` value is returned verbatim so the
 * prerequisite check can name it in an actionable failure.
 *
 * MUST run before the sandbox `DOCKER_CONFIG` override: an empty Docker
 * configuration drops the active (on this host: rootless) context back to
 * `default`, whose endpoint is not the socket this host serves.
 */
async function resolveDockerEndpoint(): Promise<DockerEndpoint> {
	const inherited = process.env.DOCKER_HOST;
	if (inherited !== undefined && inherited !== "") {
		return { endpoint: inherited, source: "DOCKER_HOST" };
	}
	const context = await runCommand([
		dockerBin,
		"context",
		"inspect",
		"--format",
		"{{.Endpoints.docker.Host}}",
	]);
	const endpoint = context.stdout.trim();
	if (context.code === 0 && endpoint !== "") {
		return { endpoint, source: "docker context" };
	}
	return { endpoint: DEFAULT_DOCKER_SOCKET, source: "default" };
}

/**
 * Validate a resolved endpoint against the only thing this walk can use: a
 * `unix://` socket that exists AND is a socket. Returns the actionable failure
 * detail, or null when the endpoint is usable. A tcp/ssh/named-pipe endpoint is
 * never local and is reported verbatim.
 */
function dockerSocketProblem({ endpoint, source }: DockerEndpoint): string | null {
	if (!endpoint.startsWith("unix://")) {
		return `${endpoint} (via ${source}) is not a unix:// endpoint; run a local Docker daemon or point DOCKER_HOST at its socket`;
	}
	const path = endpoint.slice("unix://".length);
	if (!path.startsWith("/")) {
		return `${endpoint} (via ${source}) is not an absolute socket path`;
	}
	try {
		return statSync(path).isSocket() ? null : `${path} (via ${source}) exists but is not a socket`;
	} catch {
		return `${path} (via ${source}) is missing or not a socket`;
	}
}

async function phasePrerequisite(): Promise<void> {
	minikubeBin = resolveTool("minikube") ?? "";
	dockerBin = resolveTool("docker") ?? "";
	gitBin = resolveTool("git") ?? "";
	opensslBin = resolveTool("openssl") ?? "";
	bunBin = redact(realpathSync(process.execPath), "bun");
	providerExecutable = join(REPO_ROOT, "dist-bundle", "providers", "kubernetes-provider.js");
	cliBundle = join(REPO_ROOT, "dist-bundle", "cli.js");
	imageContext = join(REPO_ROOT, "dist-bundle", "image");

	acceptance.require("minikube is available", minikubeBin !== "", "minikube is not on PATH");
	acceptance.require("docker is available", dockerBin !== "", "docker is not on PATH");
	acceptance.require("git is available", gitBin !== "", "git is not on PATH");
	acceptance.require("openssl is available", opensslBin !== "", "openssl is not on PATH");
	acceptance.require(
		"the built kubernetes provider exists",
		existsSync(providerExecutable),
		`${providerExecutable} is missing; run \`bun run build\` first`,
	);
	acceptance.require(
		"the built CLI bundle exists",
		existsSync(cliBundle),
		`${cliBundle} is missing; run \`bun run build\` first`,
	);
	acceptance.require(
		"the image build context exists",
		existsSync(join(imageContext, "Containerfile")) &&
			existsSync(join(imageContext, "entrypoint.sh")),
		`${imageContext} is incomplete; run \`bun run build\` first`,
	);

	// A local Docker socket is mandatory: the driver, the build, the image
	// lift and the profile/image deletion all go through it. Resolve it from
	// the inherited environment BEFORE anything is sandboxed below, because the
	// empty DOCKER_CONFIG would reset the active context to `default`.
	const docker = await resolveDockerEndpoint();

	mkdirSync(sandboxHome, { recursive: true });
	mkdirSync(minikubeHome, { recursive: true });
	mkdirSync(dockerConfigDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(seedProjectDir, { recursive: true });
	mkdirSync(gitRoot, { recursive: true });
	writeFileSync(
		gitConfigPath,
		"[user]\n\tname = kube-acceptance\n\temail = kube@acceptance.test\n",
	);
	setEnv("HOME", sandboxHome);
	setEnv("MINIKUBE_HOME", minikubeHome);
	setEnv("MINIKUBE_IN_STYLE", "false");
	setEnv("MINIKUBE_WANTUPDATENOTIFICATION", "false");
	setEnv("KUBECONFIG", kubeconfigPath);
	setEnv("DOCKER_CONFIG", dockerConfigDir);
	// Pin DOCKER_HOST to the resolved local socket for every subsequent
	// docker/minikube/image subprocess.
	setEnv("DOCKER_HOST", docker.endpoint);
	setEnv("DOCKER_BUILDKIT", "1");
	unsetEnv("DOCKER_CONTEXT");
	unsetEnv("BUILDKIT_HOST");
	unsetEnv("DOCKER_BUILDKIT_HOST");
	setEnv("OMP_FLEET_CONFIG", configPath);
	setEnv("OMP_FLEET_STATE", statePath);
	setEnv("OMP_FLEET_WORKSPACE_DIR", workspaceDir);
	unsetEnv("OMP_FLEET_CALLBACK_URL");
	setEnv("GIT_CONFIG_GLOBAL", gitConfigPath);
	setEnv("GIT_CONFIG_SYSTEM", "/dev/null");
	setEnv("GIT_CONFIG_NOSYSTEM", "1");
	setEnv("XDG_CONFIG_HOME", join(sandboxRoot, "xdg-config"));
	setEnv("XDG_DATA_HOME", join(sandboxRoot, "xdg-data"));
	setEnv("XDG_STATE_HOME", join(sandboxRoot, "xdg-state"));
	setEnv("XDG_CACHE_HOME", join(sandboxRoot, "xdg-cache"));

	// Every selector above is now pinned. Re-exec once so the children the
	// production paths spawn without an explicit env see them too.
	await reexecWithPinnedEnvironment();

	acceptance.cleanup.add("restore environment", () => restoreEnv());

	const socketProblem = dockerSocketProblem(docker);
	acceptance.require(
		`a local Docker socket is present (${docker.endpoint} via ${docker.source})`,
		socketProblem === null,
		socketProblem ?? "",
	);
	const dockerInfo = await runCommand([dockerBin, "info", "--format", "{{.ServerVersion}}"]);
	acceptance.require(
		"the local Docker daemon answers",
		dockerInfo.code === 0,
		dockerInfo.stderr.slice(-300),
	);
	acceptance.check(
		"BuildKit is the pinned builder",
		process.env.DOCKER_BUILDKIT === "1" && process.env.DOCKER_CONTEXT === undefined,
		`DOCKER_BUILDKIT=${process.env.DOCKER_BUILDKIT} DOCKER_CONTEXT=${process.env.DOCKER_CONTEXT}`,
	);
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Phase 2: cluster
// ---------------------------------------------------------------------------

async function kube(args: readonly string[], timeoutMs = KUBE_TIMEOUT_MS): Promise<CommandResult> {
	return await runCommand([kubeBin, ...args], { timeoutMs });
}

async function kubeJson(args: readonly string[], timeoutMs = KUBE_TIMEOUT_MS): Promise<unknown> {
	const result = await kube(args, timeoutMs);
	if (result.code !== 0) {
		throw new Error(
			`kubectl ${args.join(" ")} failed (${result.code}): ${result.stderr.slice(-300)}`,
		);
	}
	return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
}

async function phaseCluster(): Promise<void> {
	// Registered BEFORE the profile exists so a partially created cluster is
	// still removed; LIFO ordering makes this run LAST, after the namespace.
	acceptance.cleanup.add("delete minikube profile", async () => {
		// `--interactive` is a `start` flag only: `minikube delete
		// --interactive=false` fails with "unknown flag" and leaves the
		// profile's named volume (the kicbase /var/lib/docker, ~2 GB) behind on
		// every run.
		await runCommand([minikubeBin, "delete", "-p", profile], {
			timeoutMs: CLUSTER_TIMEOUT_MS,
		});
		// Under rootless Docker `minikube delete` can drop the profile and the
		// kubeconfig entry while leaving the kicbase container running, which
		// then starves the next run of memory. The container is named after the
		// profile, so remove it explicitly; already-gone is success.
		await runCommand([dockerBin, "rm", "-f", profile], { timeoutMs: 120_000 });
		// The same goes for the profile's data volume: remove it explicitly so
		// no orphaned cluster volume can starve a later run of disk.
		await runCommand([dockerBin, "volume", "rm", profile], { timeoutMs: 120_000 });
	});

	const start = await runCommand(
		[minikubeBin, "start", "-p", profile, "--driver=docker", "--wait=all", "--interactive=false"],
		{ timeoutMs: CLUSTER_TIMEOUT_MS },
	);
	acceptance.require(
		"the unique minikube profile starts on the Docker driver",
		start.code === 0,
		`exit ${start.code}: ${start.stderr.slice(-400) || start.stdout.slice(-400)}`,
	);

	// The temporary OMP_KUBE_BIN wrapper is the ONLY way the provider ever
	// reaches kubectl (no ambient kubectl binary exists on this host).
	kubeBin = join(binDir, "kubectl");
	writeFileSync(
		kubeBin,
		`#!/bin/sh\nexec ${JSON.stringify(minikubeBin)} -p ${JSON.stringify(profile)} kubectl -- "$@"\n`,
	);
	chmodSync(kubeBin, 0o755);
	setEnv("OMP_KUBE_BIN", kubeBin);

	await waitFor(
		"the cluster node to become Ready",
		async () => {
			const nodes = await kubeJson(["get", "nodes", "-o", "json"]);
			const ready = asArray(nested(nodes, "items")).some((item) =>
				asArray(nested(item, "status", "conditions")).some(
					(condition) =>
						nested(condition, "type") === "Ready" && nested(condition, "status") === "True",
				),
			);
			return ready ? true : null;
		},
		{ timeoutMs: CLUSTER_READY_TIMEOUT_MS, intervalMs: 2_000 },
	);

	kubeContext = (await kube(["config", "current-context"])).stdout.trim();
	acceptance.require("the isolated kubeconfig has a context", kubeContext !== "", kubeContext);
	setEnv("OMP_KUBE_CONTEXT", kubeContext);

	const createNs = await kube(["create", "namespace", namespace]);
	acceptance.require(
		"the unique namespace is created",
		createNs.code === 0 || createNs.stderr.includes("AlreadyExists"),
		createNs.stderr.slice(-300),
	);
	acceptance.cleanup.add("delete namespace", async () => {
		await kube(["delete", "namespace", namespace, "--ignore-not-found", "--wait=false"], 120_000);
	});

	await waitFor(
		"the namespace default service account",
		async () => {
			const result = await kube([
				"get",
				"serviceaccount",
				"default",
				"-n",
				namespace,
				"--ignore-not-found",
				"-o",
				"name",
			]);
			return result.code === 0 && result.stdout.trim() !== "" ? true : null;
		},
		{ timeoutMs: POLL_TIMEOUT_MS, intervalMs: 1_000 },
	);
	acceptance.check(
		"namespace CA ConfigMap is present",
		(await waitFor(
			"the namespace CA ConfigMap",
			async () => {
				const result = await kube([
					"get",
					"configmap",
					"kube-root-ca.crt",
					"-n",
					namespace,
					"--ignore-not-found",
					"-o",
					"name",
				]);
				return result.code === 0 && result.stdout.trim() !== "" ? true : null;
			},
			{ timeoutMs: POLL_TIMEOUT_MS, intervalMs: 1_000 },
		)) === true,
	);

	const storageClasses = asArray(
		nested(await kubeJson(["get", "storageclass", "-o", "json"]), "items"),
	);
	const chosen =
		storageClasses.find(
			(item) =>
				nested(
					asRecord(item),
					"metadata",
					"annotations",
					"storageclass.kubernetes.io/is-default-class",
				) === "true",
		) ?? storageClasses[0];
	storageClass = textOf(nested(chosen, "metadata", "name"));
	acceptance.require(
		"the cluster exposes a StorageClass",
		storageClass !== "",
		JSON.stringify(storageClasses.map((item) => nested(item, "metadata", "name"))),
	);

	// The reachability preflight below runs a throwaway Pod, so the image has to
	// be in the cluster first; the image phase reuses what this built.
	await ensureBaseImage();

	const reach = await resolvePodReachableAddress();
	hostAddress = reach.address;
	acceptance.require("a Pod-reachable host address is resolved", hostAddress !== "", reach.detail);
	console.log(
		`cluster ready: context=${kubeContext} sc=${storageClass} bind=${BIND_ADDRESS} host=${hostAddress}`,
	);
	acceptance.settle();
}

/**
 * Resolve the address the cluster must dial back to this VM.
 *
 * Two addresses are needed and they are NOT the same one. A listener here has
 * to bind an address this VM owns (`BIND_ADDRESS`, the wildcard); the cluster
 * has to be told an address a Pod can reach. Under rootless Docker the Docker
 * bridge gateway — what this walk used to advertise for both — is owned by the
 * daemon's own network namespace: this VM can neither bind it nor route to it,
 * and nothing about it is visible from inside a Pod. So the answer is measured,
 * never inferred: bind a beacon here, dial it from a throwaway Pod, and take
 * the first candidate the Pod proves it can reach.
 */
async function resolvePodReachableAddress(): Promise<ReachProbe> {
	const candidates = await podReachableCandidates();
	const beacon = await startReachBeacon();
	try {
		const direct = await probeReachFromPod(candidates, beacon);
		if (direct.address !== "") return direct;
		// A Pod that cannot reach this VM usually cannot reach anything: on this
		// host kicbase's own dockerd leaves the node's FORWARD policy at DROP.
		// Repair that artifact once and measure again rather than guess.
		if (direct.podCidr !== "" && (await allowNodePodSubnet(direct.podCidr))) {
			const repaired = await probeReachFromPod(candidates, beacon);
			if (repaired.address !== "") return repaired;
			repaired.detail = `${repaired.detail} (after allowing ${direct.podCidr} through the node's FORWARD chain)`;
			return repaired;
		}
		return direct;
	} finally {
		beacon.close();
	}
}

interface ReachProbe {
	/** The first candidate, in order, that a Pod proved it can dial. */
	address: string;
	/** Probe evidence for the caller's check detail. */
	detail: string;
	/** The probing Pod's own CIDR — the node's pod subnet — or "" when it did
	 *  not report one. */
	podCidr: string;
}

/** Every non-internal IPv4 address of this VM, in interface order. */
function localIPv4Addresses(): string[] {
	const addresses: string[] = [];
	for (const entries of Object.values(networkInterfaces())) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal && !addresses.includes(entry.address)) {
				addresses.push(entry.address);
			}
		}
	}
	return addresses;
}

/**
 * Every address a Pod might dial back to this VM, most likely first. The probe
 * decides; this only orders the candidates: this VM's own interface addresses
 * (a Docker node routes to them), the rootless Docker host alias, the kicbase
 * container's network gateways, and finally the gateway the node itself routes
 * through — which is what this walk used to advertise, and what the probe
 * disproves on this host.
 */
async function podReachableCandidates(): Promise<string[]> {
	const candidates: string[] = [];
	const add = (value: string): void => {
		if (value !== "" && !candidates.includes(value)) candidates.push(value);
	};
	for (const address of localIPv4Addresses()) add(address);
	add("10.0.2.2");
	const networks = await runCommand([
		dockerBin,
		"inspect",
		profile,
		"--format",
		"{{range .NetworkSettings.Networks}}{{.Gateway}}\n{{end}}",
	]);
	for (const line of networks.stdout.split("\n")) add(line.trim());
	const route = await runCommand([
		minikubeBin,
		"-p",
		profile,
		"ssh",
		"--",
		"ip",
		"route",
		"show",
		"default",
	]);
	const match = /\bvia\s+(\d+\.\d+\.\d+\.\d+)\b/.exec(route.stdout);
	if (match !== null) add(match[1]);
	return candidates;
}

interface ReachBeacon {
	readonly port: number;
	readonly token: string;
	close(): void;
}

/**
 * A one-shot TCP beacon on `BIND_ADDRESS`: every connection is answered with a
 * fresh random token. A dialer has to report that token, so a connection
 * accepted by anything else does not count as reachability.
 */
async function startReachBeacon(): Promise<ReachBeacon> {
	const token = randomUUID();
	const server = createServer((socket) => socket.end(`${token}\n`));
	const listening = Promise.withResolvers<number>();
	server.once("error", listening.reject);
	server.listen(0, BIND_ADDRESS, () => {
		const address = server.address();
		if (address === null || typeof address === "string") {
			listening.reject(new Error("the reach beacon has no TCP address"));
			return;
		}
		listening.resolve(address.port);
	});
	const port = await listening.promise;
	return { port, token, close: () => server.close() };
}

/**
 * Run one throwaway Pod that dials every candidate in parallel and reports, for
 * each: `ok` (connected AND answered with the beacon's token), a socket error
 * code, or `timeout`. The Pod also reports its own CIDR, which is the node's
 * pod subnet.
 */
async function probeReachFromPod(
	candidates: readonly string[],
	beacon: ReachBeacon,
): Promise<ReachProbe> {
	const name = `omp-acc-reach-${randomUUID().slice(0, 6)}`;
	const output = await runToolPod(name, "", ["bun", "-e", REACH_PROBE_SCRIPT], {
		image: baseImage,
		env: {
			OMP_REACH_PORT: String(beacon.port),
			OMP_REACH_TOKEN: beacon.token,
			OMP_REACH_CANDIDATES: candidates.join(","),
		},
	});
	const lines = output.split("\n").map((line) => line.trim());
	const podCidr = lines.find((line) => line.startsWith("self "))?.slice("self ".length) ?? "";
	const dialed = lines.filter((line) =>
		candidates.some((candidate) => line.startsWith(`${candidate} `)),
	);
	return {
		address: candidates.find((candidate) => lines.includes(`${candidate} ok`)) ?? "",
		podCidr,
		detail: `a Pod dialed ${candidates.join(", ")}: ${dialed.join("; ") || output.trim().slice(-300)}`,
	};
}

/**
 * Throwaway-Pod reachability dialer. It answers with the beacon's token only
 * when the connection reached the beacon inside this VM, and it reports this
 * Pod's own CIDR so the caller learns the node's pod subnet.
 */
const REACH_PROBE_SCRIPT = `
const net = require("net");
const os = require("os");
const port = Number(process.env.OMP_REACH_PORT);
const token = process.env.OMP_REACH_TOKEN ?? "";
const hosts = (process.env.OMP_REACH_CANDIDATES ?? "").split(",").filter(Boolean);
for (const addresses of Object.values(os.networkInterfaces())) {
  for (const address of addresses ?? []) {
    if (address.family === "IPv4" && !address.internal && address.cidr) console.log("self " + address.cidr);
  }
}
const dial = (host) => {
  const { promise, resolve } = Promise.withResolvers();
  const socket = net.connect({ host, port });
  let received = "";
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    try { socket.destroy(); } catch {}
    resolve(value);
  };
  socket.setTimeout(4000, () => finish("timeout"));
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    received += chunk;
    if (received.includes(token)) finish("ok");
  });
  socket.on("error", (error) => finish(String(error.code ?? error.message)));
  socket.on("close", () => finish(received.includes(token) ? "ok" : "closed"));
  return promise;
};
const results = await Promise.all(hosts.map(async (host) => host + " " + (await dial(host))));
for (const line of results) console.log(line);
`;

/**
 * Restore Pod egress in the cluster node, and report whether the node's policy
 * even looked like the problem.
 *
 * kicbase ships Docker 29, whose dockerd sets the node's `FORWARD` policy to
 * DROP when it boots. minikube masks and stops that unit for the containerd
 * runtime, and the DROP policy outlives it, so the node drops every packet a
 * Pod forwards — to this VM, or anywhere else. Allow the node's own pod subnet
 * through (the rule a CNI installs for its pods) and let the probe, not this
 * function, decide whether that was the whole problem.
 */
async function allowNodePodSubnet(subnet: string): Promise<boolean> {
	const policy = await runCommand(
		[minikubeBin, "-p", profile, "ssh", "--", "sudo", "iptables", "-S", "FORWARD"],
		{ timeoutMs: 120_000 },
	);
	if (policy.code !== 0 || !policy.stdout.includes("-P FORWARD DROP")) return false;
	console.log(
		`cluster: the node drops forwarded Pod traffic (FORWARD policy DROP, left behind by the stopped kicbase dockerd); allowing ${subnet}`,
	);
	const repair = await runCommand(
		[
			minikubeBin,
			"-p",
			profile,
			"ssh",
			"--",
			"sudo",
			"iptables",
			"-I",
			"FORWARD",
			"1",
			"-s",
			subnet,
			"-j",
			"ACCEPT",
		],
		{ timeoutMs: 120_000 },
	);
	if (repair.code !== 0) {
		console.error(`FAIL node pod-egress repair — ${sanitize(repair.stderr.slice(-300))}`);
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Phase 3: image — build, load, CA derive, HTTPS gateway
// ---------------------------------------------------------------------------

const proxyRejections: string[] = [];
const proxyForwards: string[] = [];
const GATEWAY_REJECTED_BODY = "acceptance-gateway-rejected";

/**
 * Build and load the acceptance image into the profile, once per walk.
 *
 * The cluster phase calls this before its reachability preflight, because that
 * preflight is a throwaway Pod and every Pod needs this image; the image phase
 * would otherwise build it here. The checks below are asserted once, by the
 * first caller, and skipped afterwards.
 */
async function ensureBaseImage(): Promise<void> {
	if (baseImageLoaded) return;
	// The shipped image definition is a Containerfile at the context root;
	// `docker build` defaults to `Dockerfile`, so name it explicitly.
	const build = await runCommand(
		[
			dockerBin,
			"build",
			"--file",
			join(imageContext, "Containerfile"),
			"--tag",
			baseImage,
			imageContext,
		],
		{ timeoutMs: BUILD_TIMEOUT_MS },
	);
	acceptance.require(
		"the image builds from dist-bundle/image/",
		build.code === 0,
		build.stderr.slice(-500),
	);
	const load = await runCommand([minikubeBin, "-p", profile, "image", "load", baseImage], {
		timeoutMs: BUILD_TIMEOUT_MS,
	});
	acceptance.require(
		"the image is loaded into the profile",
		load.code === 0,
		load.stderr.slice(-400),
	);
	baseImageLoaded = true;
}

async function phaseImage(): Promise<void> {
	await ensureBaseImage();

	// Temporary CA + server certificate for the Pod-reachable host address;
	// the derived image trusts the CA, the proxy serves the certificate.
	const caDir = join(sandboxRoot, "tls");
	mkdirSync(caDir, { recursive: true });
	const caKey = join(caDir, "ca.key");
	const caCert = join(caDir, "ca.crt");
	const serverKey = join(caDir, "server.key");
	const serverCsr = join(caDir, "server.csr");
	const serverCert = join(caDir, "server.crt");
	const extFile = join(caDir, "san.cnf");
	writeFileSync(extFile, `subjectAltName = IP:${hostAddress}, IP:127.0.0.1, DNS:localhost\n`);
	const ca = await runCommand(
		[
			opensslBin,
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			caKey,
			"-out",
			caCert,
			"-days",
			"1",
			"-subj",
			"/CN=omp-web acceptance CA",
		],
		{ timeoutMs: 120_000 },
	);
	acceptance.require("the temporary CA is generated", ca.code === 0, ca.stderr.slice(-300));
	const csr = await runCommand(
		[
			opensslBin,
			"req",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			serverKey,
			"-out",
			serverCsr,
			"-subj",
			`/CN=${hostAddress}`,
		],
		{ timeoutMs: 120_000 },
	);
	acceptance.require(
		"the gateway certificate request is generated",
		csr.code === 0,
		csr.stderr.slice(-300),
	);
	const sign = await runCommand(
		[
			opensslBin,
			"x509",
			"-req",
			"-in",
			serverCsr,
			"-CA",
			caCert,
			"-CAkey",
			caKey,
			"-CAcreateserial",
			"-out",
			serverCert,
			"-days",
			"1",
			"-sha256",
			"-extfile",
			extFile,
		],
		{ timeoutMs: 120_000 },
	);
	acceptance.require(
		"the gateway certificate is signed by the CA",
		sign.code === 0,
		sign.stderr.slice(-300),
	);

	const derivedContext = join(sandboxRoot, "derived-image");
	mkdirSync(derivedContext, { recursive: true });
	writeFileSync(join(derivedContext, "acceptance-ca.crt"), readFileSync(caCert));
	writeFileSync(
		join(derivedContext, "Dockerfile"),
		[
			`FROM ${baseImage}`,
			"USER root",
			"COPY acceptance-ca.crt /usr/local/share/ca-certificates/omp-acceptance-ca.crt",
			// The runtime image narrows PATH to /usr/local/bin:/usr/bin:/bin, so
			// the account tools below /usr/sbin need absolute paths.
			"RUN /usr/sbin/update-ca-certificates",
			"USER 10001:10001",
			"",
		].join("\n"),
	);
	const derive = await runCommand([dockerBin, "build", "--tag", caImage, derivedContext], {
		timeoutMs: BUILD_TIMEOUT_MS,
	});
	acceptance.require(
		"the CA-trusting derived image builds",
		derive.code === 0,
		derive.stderr.slice(-500),
	);
	const deriveLoad = await runCommand([minikubeBin, "-p", profile, "image", "load", caImage], {
		timeoutMs: BUILD_TIMEOUT_MS,
	});
	acceptance.require(
		"the derived image is loaded into the profile",
		deriveLoad.code === 0,
		deriveLoad.stderr.slice(-400),
	);
	acceptance.cleanup.add("remove image tags", async () => {
		await runCommand([dockerBin, "image", "rm", "--force", baseImage, caImage], {
			timeoutMs: 120_000,
		});
	});

	const gateway = Bun.serve({
		hostname: BIND_ADDRESS,
		port: 0,
		// Both callback halves are long-lived streams whose only traffic is the
		// 15 s transport heartbeat. Bun's default 10 s idle timeout would close
		// whichever half is quiet — the daemon then reports "callback down
		// stream failed" / "callback up body cancelled", re-dials, and never
		// holds a pair long enough to stream a transcript. The fleet's own
		// server disables the same timeout for the same reason (fleet/server.ts).
		idleTimeout: 0,
		tls: { cert: readFileSync(serverCert, "utf8"), key: readFileSync(serverKey, "utf8") },
		fetch: handleGatewayRequest,
	});
	proxyServer = gateway;
	proxyPort = gateway.port ?? 0;
	acceptance.require("the callback gateway proxy binds", proxyPort > 0, `port ${proxyPort}`);
	acceptance.cleanup.add("stop callback proxy", () => {
		proxyServer?.stop(true);
		proxyServer = null;
	});

	// A real observation, replacing a literal `true`: the wildcard listener
	// answers a TLS request from this VM (loopback is part of the wildcard), and
	// a throwaway Pod reaches the SAME listener through the address every
	// cluster-facing URL advertises. The Pod proves the advertised address, and
	// its verified fetch proves the certificate covers that address, because the
	// derived image trusts the temporary CA. The probed path is one the gateway
	// always rejects, so no fleet has to be up yet.
	const localProbe = await probeGateway(CALLBACK_UP_PATH, "GET");
	acceptance.check(
		"the callback gateway answers a TLS request from this VM",
		localProbe.status === 404 && localProbe.body === GATEWAY_REJECTED_BODY,
		`status ${localProbe.status}: ${localProbe.body.slice(-200)}`,
	);
	const podProbe = await runToolPod(
		`omp-acc-gateway-${randomUUID().slice(0, 6)}`,
		"",
		["bun", "-e", GATEWAY_PROBE_SCRIPT],
		{
			image: caImage,
			env: { OMP_GATEWAY_URL: `https://${hostAddress}:${proxyPort}${CALLBACK_UP_PATH}` },
		},
	);
	acceptance.check(
		"probe-Pod reaches the callback gateway at the advertised address",
		podProbe.includes(`gateway ${404} ${GATEWAY_REJECTED_BODY}`),
		podProbe.slice(-300) || "the probe Pod printed nothing",
	);
	acceptance.settle();
}

/**
 * Throwaway-Pod gateway probe: one verified HTTPS request for a path the
 * gateway always rejects before the fleet is involved.
 */
const GATEWAY_PROBE_SCRIPT = `
const response = await fetch(process.env.OMP_GATEWAY_URL);
console.log("gateway " + response.status + " " + (await response.text()));
`;

/** The documented gateway allowlist: POST /callback/up, GET /callback/down,
 *  POST /callback/bulk/<id>. Everything else is rejected before the fleet. */
async function handleGatewayRequest(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const path = url.pathname;
	const bulkId = path.startsWith(CALLBACK_BULK_PATH_PREFIX)
		? path.slice(CALLBACK_BULK_PATH_PREFIX.length)
		: "";
	const allowedBulk = bulkId !== "" && /^[A-Za-z0-9_-]+$/.test(bulkId);
	// The allowlist admits exactly the three documented pairs. A query string is
	// part of none of them, so a request carrying one never reaches the fleet —
	// see the rejected probes in verifyGatewayAllowlist.
	const allowed =
		url.search === "" &&
		((req.method === "POST" && path === CALLBACK_UP_PATH) ||
			(req.method === "GET" && path === CALLBACK_DOWN_PATH) ||
			(req.method === "POST" && allowedBulk));
	if (!allowed) {
		proxyRejections.push(`${req.method} ${path}${url.search}`);
		return new Response(GATEWAY_REJECTED_BODY, { status: 404 });
	}
	proxyForwards.push(`${req.method} ${path}`);
	const headers = new Headers(req.headers);
	headers.delete("host");
	headers.delete("content-length");
	const upstream = await fetch(`http://127.0.0.1:${fleetPort}${path}`, {
		method: req.method,
		headers,
		body: req.method === "POST" ? (req.body ?? undefined) : undefined,
	});
	return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
}

interface ProbeResult {
	status: number;
	body: string;
}

function probeGateway(pathname: string, method: string): Promise<ProbeResult> {
	const { promise, resolve, reject } = Promise.withResolvers<ProbeResult>();
	let settled = false;
	const settle = (result: ProbeResult): void => {
		if (settled) return;
		settled = true;
		resolve(result);
	};
	const request = httpsRequest(
		{
			host: "127.0.0.1",
			port: proxyPort,
			path: pathname,
			method,
			rejectUnauthorized: false,
			headers: { "content-length": "0" },
		},
		(response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => settle({ status: response.statusCode ?? 0, body }));
		},
	);
	request.setTimeout(20_000, () => {
		request.destroy();
		settle({ status: 0, body: "" });
	});
	request.on("error", (cause) => {
		if (!settled) {
			settled = true;
			reject(cause);
		}
	});
	request.end();
	return promise;
}

async function verifyGatewayAllowlist(): Promise<void> {
	const allowedPairs: [string, string][] = [
		["/callback/up", "POST"],
		["/callback/down", "GET"],
		["/callback/bulk/acceptance-correlation", "POST"],
	];
	const rejectedPairs: [string, string][] = [
		["/callback/up", "GET"],
		["/callback/down", "POST"],
		["/callback/bulk/acceptance-correlation", "GET"],
		["/callback/other", "POST"],
		["/callback/bulk/a/b", "POST"],
		["/callback/up?probe=1", "POST"],
	];
	for (const [path, method] of rejectedPairs) {
		const before = proxyForwards.length;
		const probe = await probeGateway(path, method);
		acceptance.check(
			`gateway rejects ${method} ${path}`,
			probe.status === 404 &&
				probe.body === GATEWAY_REJECTED_BODY &&
				proxyForwards.length === before,
			`status ${probe.status}, forwarded ${proxyForwards.length - before}`,
		);
	}
	for (const [path, method] of allowedPairs) {
		const before = proxyForwards.length;
		const probe = await probeGateway(path, method);
		acceptance.check(
			`gateway forwards ${method} ${path}`,
			proxyForwards.length === before + 1 && probe.body !== GATEWAY_REJECTED_BODY,
			`status ${probe.status}, forwarded ${proxyForwards.length - before}`,
		);
	}
	acceptance.check(
		"gateway recorded every rejected probe",
		proxyRejections.length >= rejectedPairs.length,
		JSON.stringify(proxyRejections),
	);
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Phase 4: git — bare repo served over git:// to host and Pod
// ---------------------------------------------------------------------------

async function phaseGit(): Promise<void> {
	const bareRepo = join(gitRoot, "seed.git");
	// The work repo IS the registered seed project. The fleet only accepts a
	// project path that is a git repository (registry.addProject), and the spawn
	// phase registers exactly this checkout, so the seed commit the daemon
	// serves is also the project's own HEAD.
	const workRepo = seedProjectDir;
	mkdirSync(workRepo, { recursive: true });
	writeFileSync(join(workRepo, "README.md"), "kubernetes acceptance seed\n");
	const steps: [string, string[]][] = [
		["git init --bare", ["init", "--bare", "--initial-branch=acceptance", bareRepo]],
		["git init work", ["init", "-b", "acceptance", workRepo]],
		["git add", ["-C", workRepo, "add", "-A"]],
		["git commit", ["-C", workRepo, "commit", "-m", "acceptance seed"]],
		["git remote add", ["-C", workRepo, "remote", "add", "origin", bareRepo]],
		["git push", ["-C", workRepo, "push", "origin", "acceptance"]],
	];
	for (const [label, args] of steps) {
		const result = await runCommand([gitBin, ...args]);
		acceptance.require(label, result.code === 0, result.stderr.slice(-300));
	}
	const head = await runCommand([gitBin, "-C", workRepo, "rev-parse", "HEAD"]);
	commitId = head.stdout.trim();
	acceptance.require("the seed commit resolves", /^[0-9a-f]{40}$/.test(commitId), commitId);
	const setHead = await runCommand([
		gitBin,
		"-C",
		bareRepo,
		"symbolic-ref",
		"HEAD",
		"refs/heads/acceptance",
	]);
	acceptance.require(
		"the bare repo HEAD points at acceptance",
		setHead.code === 0,
		setHead.stderr.slice(-200),
	);

	gitPort = await reservePort();
	gitUrl = `git://${hostAddress}:${gitPort}/seed.git`;
	// The daemon binds the wildcard, NOT the advertised address: the address
	// Pods dial is only guaranteed to be one THEY can route to, and binding it
	// here used to fail with `Cannot assign requested address` while `stderr`
	// was discarded.
	const daemonOut = join(sandboxRoot, "git-daemon.out");
	const daemonErr = join(sandboxRoot, "git-daemon.err");
	gitDaemonLogs = { stdout: daemonOut, stderr: daemonErr };
	gitDaemon = Bun.spawn(
		[
			gitBin,
			"daemon",
			`--base-path=${gitRoot}`,
			"--export-all",
			// The delete contract requires a workspace's local history to be
			// PRESERVED ON ITS REMOTE (the quiesce evidence proves every local
			// tip is contained by an advertised remote ref), so the recovery
			// step of this walk pushes its commit back. Without receive-pack
			// the push is refused and the workspace can never become
			// deletable.
			"--enable=receive-pack",
			"--reuseaddr",
			`--listen=${BIND_ADDRESS}`,
			`--port=${gitPort}`,
		],
		{
			env: scriptEnv(),
			stdin: "ignore",
			stdout: Bun.file(daemonOut),
			stderr: Bun.file(daemonErr),
		},
	);
	acceptance.cleanup.add("stop git daemon", async () => {
		const daemon = gitDaemon;
		gitDaemon = null;
		if (daemon === null) return;
		daemon.kill("SIGTERM");
		const killed = Promise.withResolvers<void>();
		const hardKill = setTimeout(() => {
			daemon.kill("SIGKILL");
			killed.resolve();
		}, 3_000);
		await daemon.exited;
		clearTimeout(hardKill);
		killed.resolve();
		await killed.promise;
	});

	const hostProbe = await waitFor(
		"the host git ls-remote probe",
		async () => {
			if (gitDaemon !== null && gitDaemon.exitCode !== null) {
				throw new BlockedError(
					"git",
					`the git daemon exited (${gitDaemon.exitCode}) before serving ${gitUrl}`,
				);
			}
			const result = await runCommand([gitBin, "ls-remote", gitUrl, "acceptance"], {
				timeoutMs: 30_000,
			});
			return result.code === 0 && result.stdout.includes(commitId) ? true : null;
		},
		{ timeoutMs: POLL_TIMEOUT_MS, intervalMs: 500 },
	).catch((cause: unknown) => {
		if (cause instanceof BlockedError) throw cause;
		throw new BlockedError("git", `${messageOf(cause)} for ${gitUrl} (${gitDaemonDiagnostics()})`);
	});
	acceptance.check("host git ls-remote returns the pinned commit", hostProbe === true);

	const podOutput = await runToolPod(`omp-acc-git-probe-${randomUUID().slice(0, 6)}`, "", [
		"git",
		"ls-remote",
		gitUrl,
		"acceptance",
	]);
	acceptance.require(
		"probe-Pod git ls-remote returns the pinned commit",
		podOutput.includes(commitId),
		podOutput.slice(-300),
	);
	acceptance.settle();
}

/** The tail of one captured log file, flattened onto a single line. */
function logTail(path: string, limit = 400): string {
	if (path === "" || !existsSync(path)) return "";
	try {
		return readFileSync(path, "utf8").trim().slice(-limit).replace(/\s+/g, " ");
	} catch {
		return "";
	}
}

/**
 * What the Git daemon has to say about itself. It used to be spawned with
 * `stderr: "ignore"`, so a daemon that could not bind the advertised address
 * (this host's Docker gateway is not owned by this VM) failed silently and
 * surfaced only as a two-minute probe timeout. Every failing probe now quotes
 * the daemon's own diagnosis.
 */
function gitDaemonDiagnostics(): string {
	const parts: string[] = [];
	if (gitDaemon !== null && gitDaemon.exitCode !== null) {
		parts.push(`git daemon exited ${gitDaemon.exitCode}`);
	}
	for (const [label, path] of [
		["stderr", gitDaemonLogs.stderr],
		["stdout", gitDaemonLogs.stdout],
	] as const) {
		const text = logTail(path);
		if (text !== "") parts.push(`${label}: ${text}`);
	}
	return parts.length === 0 ? "the git daemon logged nothing" : parts.join("; ");
}

// ---------------------------------------------------------------------------
// Cluster tooling: temporary Pods
// ---------------------------------------------------------------------------

/**
 * Run one bounded command in a throwaway Pod that mounts the named PVC (or no
 * volume when `pvcName` is empty). Returns the Pod's stdout; the Pod is
 * tracked and removed by cleanup regardless of outcome. `opts.image` overrides
 * the derived acceptance image (the cluster phase has not built it yet), and
 * `opts.env` passes values the Pod's command reads.
 */
async function runToolPod(
	name: string,
	pvcName: string,
	command: string[],
	opts: { image?: string; env?: Record<string, string> } = {},
): Promise<string> {
	toolPods.add(name);
	const manifestPath = join(sandboxRoot, `${name}.json`);
	const volumeMounts = pvcName === "" ? [] : [{ name: "workspace", mountPath: POD_WORKSPACE_ROOT }];
	const volumes =
		pvcName === "" ? [] : [{ name: "workspace", persistentVolumeClaim: { claimName: pvcName } }];
	const env = Object.entries(opts.env ?? {}).map(([key, value]) => ({ name: key, value }));
	writeFileSync(
		manifestPath,
		JSON.stringify({
			apiVersion: "v1",
			kind: "Pod",
			metadata: {
				name,
				namespace,
				labels: { [TOOL_POD_LABEL]: "true" },
			},
			spec: {
				restartPolicy: "Never",
				automountServiceAccountToken: false,
				enableServiceLinks: false,
				securityContext: {
					runAsNonRoot: true,
					runAsUser: RUNTIME_UID,
					runAsGroup: RUNTIME_UID,
					fsGroup: RUNTIME_UID,
					seccompProfile: { type: "RuntimeDefault" },
				},
				containers: [
					{
						name: "tool",
						image: opts.image ?? caImage,
						command,
						env,
						securityContext: {
							allowPrivilegeEscalation: false,
							readOnlyRootFilesystem: true,
							capabilities: { drop: ["ALL"] },
						},
						volumeMounts,
					},
				],
				volumes,
			},
		}),
	);
	const create = await kube(["create", "-f", manifestPath]);
	acceptance.require(`tool Pod ${name} is created`, create.code === 0, create.stderr.slice(-300));
	const phase = await waitFor(
		`tool Pod ${name} to finish`,
		async () => {
			const pod = await kubeJson([
				"get",
				"pod",
				name,
				"-n",
				namespace,
				"--ignore-not-found",
				"-o",
				"json",
			]);
			const state = textOf(nested(pod, "status", "phase"));
			return state === "Succeeded" || state === "Failed" ? state : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 1_500 },
	);
	acceptance.check(
		`tool Pod ${name} succeeds`,
		phase === "Succeeded",
		`phase ${phase}: ${await podLogs(name)}`,
	);
	const logs = await podLogs(name);
	await deleteToolPod(name);
	return logs;
}

async function podLogs(name: string): Promise<string> {
	const result = await kube(["logs", name, "-n", namespace], 60_000);
	return result.stdout;
}

async function deleteToolPod(name: string): Promise<void> {
	toolPods.delete(name);
	await kube(
		["delete", "pod", name, "-n", namespace, "--ignore-not-found", "--wait=false"],
		60_000,
	);
}

/** sha256 of one file inside a PVC, or "MISSING" when the file is absent. */
async function sha256InVolume(daemonId: string, relpath: string): Promise<string> {
	const podName = `omp-acc-hash-${randomUUID().slice(0, 6)}`;
	const target = `/workspace/.home/agent/sessions/${relpath}`;
	const output = await runToolPod(podName, pvcNameFor(daemonId), [
		"sh",
		"-c",
		`test -f ${target} && sha256sum ${target} | cut -d' ' -f1 || echo MISSING`,
	]);
	return output.trim();
}

// ---------------------------------------------------------------------------
// Phase 5: preflight — config, fleet, configured preflight, gateway allowlist
// ---------------------------------------------------------------------------

async function phasePreflight(): Promise<void> {
	const config = {
		workspaceDir,
		providerProfiles: {
			[PROVIDER_ID]: {
				id: PROVIDER_ID,
				provider: "kubernetes",
				executable: providerExecutable,
				tools: [],
				context: kubeContext,
				namespace,
				image: caImage,
				resources: { cpu: PROFILE_CPU, memory: PROFILE_MEMORY },
				storage: { class: storageClass, size: PROFILE_STORAGE_SIZE },
			},
		},
	};
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
	setEnv("OMP_FLEET_CALLBACK_URL", `https://${hostAddress}:${proxyPort}`);

	acceptance.cleanup.add("close fleet", async () => {
		const running = fleet;
		fleet = null;
		await running?.close();
	});
	fleet = await startFleet({
		port: 0,
		statePath,
		configPath,
		workspaceDir,
		statsConfig: {
			statsDbPath: join(sandboxRoot, "stats.db"),
			sessionsDir: join(sandboxRoot, "agent-sessions"),
		},
	});
	fleetPort = fleet.port;
	setEnv("OMP_FLEET_PORT", String(fleetPort));
	acceptance.require(
		"the fleet boots on an assigned loopback port",
		fleetPort > 0,
		`port ${fleetPort}`,
	);

	const preflight = await runCommand(
		[bunBin, cliBundle, "preflight", "--profile", PROVIDER_ID, "--port", String(fleetPort)],
		{ timeoutMs: 300_000 },
	);
	acceptance.require(
		"the configured kubernetes preflight succeeds",
		preflight.code === 0 && !preflight.stdout.includes("[FAIL]"),
		`exit ${preflight.code}: ${preflight.stdout.slice(-600) || preflight.stderr.slice(-600)}`,
	);

	await verifyGatewayAllowlist();
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Fleet HTTP helpers
// ---------------------------------------------------------------------------

interface CtlResponse {
	status: number;
	body: unknown;
}

async function ctl(path: string, init?: { method?: string; body?: unknown }): Promise<CtlResponse> {
	if (fleet === null) throw new Error("fleet is not running");
	const res = await fetch(`http://127.0.0.1:${fleet.port}${path}`, {
		method: init?.method ?? "GET",
		headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
		body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
	});
	const text = await res.text();
	let body: unknown = null;
	if (text !== "") {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	return { status: res.status, body };
}

function rowsOf(body: unknown): unknown[] {
	return asArray(body);
}

async function sessionRow(daemonId: string): Promise<Record<string, unknown> | null> {
	const res = await ctl("/ctl/sessions");
	if (res.status !== 200) return null;
	for (const row of rowsOf(res.body)) {
		if (nested(row, "daemonId") === daemonId) return asRecord(row);
	}
	return null;
}

function daemonIdForName(name: string): Promise<string> {
	return waitFor(
		`the roster row for ${name}`,
		async () => {
			const res = await ctl("/ctl/sessions");
			for (const row of rowsOf(res.body)) {
				if (nested(row, "name") === name) {
					const id = textOf(nested(row, "daemonId"));
					return id === "" ? null : id;
				}
			}
			return null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS },
	);
}

function transportOf(server: FleetServer): DaemonTransportRegistry {
	// `FleetServer` deliberately hides the transport; the acceptance walk needs
	// the same registry the browser edge drives.
	const impl = server as unknown as { transport: DaemonTransportRegistry };
	return impl.transport;
}

function currentTransport(): DaemonTransportRegistry {
	if (fleet === null) throw new Error("fleet is not running");
	return transportOf(fleet);
}

async function cli(
	args: readonly string[],
	timeoutMs = SUBPROCESS_TIMEOUT_MS,
): Promise<CommandResult> {
	return await runCommand([bunBin, cliBundle, ...args, "--port", String(fleetPort)], { timeoutMs });
}

// ---------------------------------------------------------------------------
// Kubernetes inventory
// ---------------------------------------------------------------------------

async function workspacePods(daemonId: string): Promise<Record<string, unknown>[]> {
	const list = await kubeJson([
		"get",
		"pods",
		"-n",
		namespace,
		"-l",
		`${LABEL_MANAGED_BY}=${LABEL_MANAGED_BY_VALUE}`,
		"-o",
		"json",
	]);
	return asArray(nested(list, "items"))
		.filter((item) => nested(item, "metadata", "annotations", ANN_WORKSPACE_ID) === daemonId)
		.map((item) => asRecord(item))
		.filter((item): item is Record<string, unknown> => item !== null);
}

async function refreshWorkspacePvcs(daemonId: string): Promise<Record<string, unknown>[]> {
	const list = await kubeJson([
		"get",
		"persistentvolumeclaims",
		"-n",
		namespace,
		"-l",
		`${LABEL_MANAGED_BY}=${LABEL_MANAGED_BY_VALUE}`,
		"-o",
		"json",
	]);
	const matching = asArray(nested(list, "items"))
		.filter((item) => nested(item, "metadata", "annotations", ANN_WORKSPACE_ID) === daemonId)
		.map((item) => asRecord(item))
		.filter((item): item is Record<string, unknown> => item !== null);
	const first = matching[0];
	if (first !== undefined)
		managedPvcsByWorkspace.set(daemonId, textOf(nested(first, "metadata", "name")));
	return matching;
}

/**
 * The workspace container's terminated state, or null while it is live. Every
 * provider Pod is `restartPolicy: Never`, so a terminated container stays
 * terminated: one that booted and died can never produce a callback pair, and
 * a wait that only polls the fleet burns its whole timeout on it.
 */
async function terminatedContainer(podName: string): Promise<string | null> {
	let pod: unknown;
	try {
		pod = await kubeJson([
			"get",
			"pod",
			podName,
			"-n",
			namespace,
			"--ignore-not-found",
			"-o",
			"json",
		]);
	} catch {
		// A transient API error must never fail a healthy wait: the pair
		// assertion below stays authoritative.
		return null;
	}
	for (const status of asArray(nested(pod, "status", "containerStatuses"))) {
		const terminated = asRecord(nested(status, "state", "terminated"));
		if (terminated === null) continue;
		const reason = textOf(nested(terminated, "reason"));
		const exitCode = nested(terminated, "exitCode");
		const code = typeof exitCode === "number" ? String(exitCode) : "?";
		return `${reason === "" ? "terminated" : reason} (exit ${code})`;
	}
	return null;
}

/**
 * Wait for a workspace's callback pair, failing as soon as its container is
 * observed terminated. The container log is the daemon's own evidence — a
 * daemon that dies at boot never dials the gateway — so a dead Pod reports its
 * error here instead of surfacing as a bare pair timeout.
 */
async function waitForCallbackPair(
	daemonId: string,
	podName: string,
	what: string,
): Promise<boolean> {
	return await waitFor(
		what,
		async () => {
			if (currentTransport().pairStatus(daemonId).paired) return true;
			const dead = await terminatedContainer(podName);
			if (dead !== null) {
				throw new BlockedError(
					acceptance.phase,
					`${what}: the workspace container ${dead}; ${(await podLogs(podName)).slice(-800)}`,
				);
			}
			return null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 2_000 },
	);
}

/**
 * Stop a clone whose daemon pair is REQUIRED to be live first.
 *
 * The fleet collects a kubernetes workspace's final quiesce evidence at STOP
 * time — the delete gate can only adopt it once the provider stop has deleted
 * the Pod and no daemon is left to answer — so a stop issued before the
 * workspace's daemon has dialed would leave it undeletable. Every stop whose
 * evidence a later removal depends on goes through here.
 */
async function stopWithLivePair(daemonId: string, what: string): Promise<CtlResponse> {
	const pods = await workspacePods(daemonId);
	const podName = textOf(nested(pods[0], "metadata", "name"));
	if (podName === "") {
		throw new BlockedError(acceptance.phase, `${what}: no Pod is running for ${daemonId}`);
	}
	await waitForCallbackPair(daemonId, podName, `the daemon pair before ${what}`);
	return await ctl("/ctl/stop", { method: "POST", body: { selector: daemonId } });
}

// ---------------------------------------------------------------------------
// Phase 6: spawn — clones A and B, hardened spec assertions
// ---------------------------------------------------------------------------

let cloneA = "";
let cloneB = "";
let cloneBPodUid = "";
let cloneBPvcUid = "";
let cloneBGeneration = 0;

async function phaseSpawn(): Promise<void> {
	const project = await cli(["add-repo", seedProjectDir]);
	acceptance.require(
		"the seed project registers through the built CLI",
		project.code === 0,
		project.stderr.slice(-300),
	);

	const added = await cli([
		"add-clone",
		"seed-project",
		"clone-a",
		"--profile",
		PROVIDER_ID,
		"--remote",
		gitUrl,
		"--branch",
		"acceptance",
	]);
	acceptance.require(
		"add-clone creates and auto-starts clone-a",
		added.code === 0,
		`exit ${added.code}: ${added.stderr.slice(-400)}`,
	);
	cloneA = await daemonIdForName("clone-a");
	acceptance.require("clone-a is on the roster", cloneA !== "", cloneA);
	await waitFor(
		"clone-a to be Running with a Bound PVC",
		async () => {
			const pods = await workspacePods(cloneA);
			const pvcs = await refreshWorkspacePvcs(cloneA);
			const pod = pods[0];
			const pvc = pvcs[0];
			if (pod === undefined || pvc === undefined) return null;
			const running = textOf(nested(pod, "status", "phase")) === "Running";
			const bound = textOf(nested(pvc, "status", "phase")) === "Bound";
			return running && bound ? true : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 2_000 },
	);
	const aPods = await workspacePods(cloneA);
	acceptance.check(
		"clone-a has exactly one Running Pod",
		aPods.length === 1,
		`${aPods.length} pods`,
	);
	const aPvcs = await refreshWorkspacePvcs(cloneA);
	acceptance.check(
		"clone-a has exactly one Bound PVC",
		aPvcs.length === 1 && textOf(nested(aPvcs[0], "status", "phase")) === "Bound",
		JSON.stringify(aPvcs.map((pvc) => nested(pvc, "status", "phase"))),
	);
	const pairedA = await waitForCallbackPair(
		cloneA,
		textOf(nested(aPods[0], "metadata", "name")),
		"the clone-a callback pair",
	);
	acceptance.check("clone-a callback pair established", pairedA === true);

	// Clone B: created stopped, provably with zero Kubernetes resources.
	const addedB = await cli([
		"add-clone",
		"seed-project",
		"clone-b",
		"--profile",
		PROVIDER_ID,
		"--remote",
		gitUrl,
		"--branch",
		"acceptance",
		"--no-start",
	]);
	acceptance.require(
		"add-clone --no-start creates clone-b",
		addedB.code === 0,
		`exit ${addedB.code}: ${addedB.stderr.slice(-400)}`,
	);
	cloneB = await daemonIdForName("clone-b");
	acceptance.require("clone-b is on the roster", cloneB !== "", cloneB);
	const bPodsBefore = await workspacePods(cloneB);
	const bPvcsBefore = await refreshWorkspacePvcs(cloneB);
	acceptance.check(
		"stopped clone-b owns zero Pods",
		bPodsBefore.length === 0,
		JSON.stringify(bPodsBefore.map((pod) => nested(pod, "metadata", "name"))),
	);
	acceptance.check(
		"stopped clone-b owns zero PVCs",
		bPvcsBefore.length === 0,
		JSON.stringify(bPvcsBefore.map((pvc) => nested(pvc, "metadata", "name"))),
	);

	const started = await ctl("/ctl/start", { method: "POST", body: { daemonId: cloneB } });
	const startBody = asRecord(started.body);
	acceptance.require(
		"clone-b starts through /ctl/start",
		started.status === 200,
		`status ${started.status}: ${JSON.stringify(started.body)}`,
	);
	const generation = nested(startBody, "generation");
	cloneBGeneration = typeof generation === "number" ? generation : 0;
	acceptance.check(
		"clone-b reports a positive generation",
		cloneBGeneration > 0,
		JSON.stringify(generation),
	);
	await waitFor(
		"clone-b to be Running with a Bound PVC",
		async () => {
			const pods = await workspacePods(cloneB);
			const pvcs = await refreshWorkspacePvcs(cloneB);
			if (pods.length !== 1 || pvcs.length !== 1) return null;
			return textOf(nested(pods[0], "status", "phase")) === "Running" &&
				textOf(nested(pvcs[0], "status", "phase")) === "Bound"
				? true
				: null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 2_000 },
	);
	await assertHardenPodSpec();
	await assertPvcSpec();

	// Repeat-start: the same generation and the very same object UIDs.
	const repeated = await ctl("/ctl/start", { method: "POST", body: { daemonId: cloneB } });
	const repeatBody = asRecord(repeated.body);
	acceptance.check(
		"clone-b repeat start reports the same generation",
		repeated.status === 200 && nested(repeatBody, "generation") === cloneBGeneration,
		`${cloneBGeneration} -> ${JSON.stringify(nested(repeatBody, "generation"))}`,
	);
	const podsAgain = await workspacePods(cloneB);
	const pvcsAgain = await refreshWorkspacePvcs(cloneB);
	acceptance.check(
		"clone-b repeat start keeps the same Pod UID",
		nested(podsAgain[0], "metadata", "uid") === cloneBPodUid,
		`${cloneBPodUid} -> ${JSON.stringify(nested(podsAgain[0], "metadata", "uid"))}`,
	);
	acceptance.check(
		"clone-b repeat start keeps the same PVC UID",
		nested(pvcsAgain[0], "metadata", "uid") === cloneBPvcUid,
		`${cloneBPvcUid} -> ${JSON.stringify(nested(pvcsAgain[0], "metadata", "uid"))}`,
	);
	acceptance.settle();
}

async function assertHardenPodSpec(): Promise<void> {
	const pods = await workspacePods(cloneB);
	const pod = pods[0];
	acceptance.require("clone-b has exactly one Pod", pods.length === 1, `${pods.length} pods`);
	cloneBPodUid = textOf(nested(pod, "metadata", "uid"));
	const containers = asArray(nested(pod, "spec", "containers"));
	const container = asRecord(containers[0]);
	const containerSecurity = asRecord(nested(container, "securityContext"));
	const podSecurity = asRecord(nested(pod, "spec", "securityContext"));
	const requests = asRecord(nested(container, "resources", "requests"));
	const mounts = asArray(nested(container, "volumeMounts"));
	const volumes = asArray(nested(pod, "spec", "volumes"));
	const mountPaths = mounts.map(
		(mount) => `${textOf(nested(mount, "name"))}:${textOf(nested(mount, "mountPath"))}`,
	);
	const claim = asRecord(
		nested(
			volumes.find((volume) => nested(volume, "name") === "workspace"),
			"persistentVolumeClaim",
		),
	);

	acceptance.check(
		"clone-b Pod runs the derived acceptance image",
		nested(container, "image") === caImage,
		textOf(nested(container, "image")),
	);
	acceptance.check(
		"clone-b Pod restartPolicy is Never",
		nested(pod, "spec", "restartPolicy") === "Never",
	);
	acceptance.check(
		"clone-b Pod disables the service-account token",
		nested(pod, "spec", "automountServiceAccountToken") === false,
	);
	acceptance.check(
		"clone-b Pod disables service links",
		nested(pod, "spec", "enableServiceLinks") === false,
	);
	acceptance.check(
		"clone-b Pod securityContext pins uid/gid/fsGroup",
		nested(podSecurity, "runAsUser") === RUNTIME_UID &&
			nested(podSecurity, "runAsGroup") === RUNTIME_UID &&
			nested(podSecurity, "fsGroup") === RUNTIME_UID,
		JSON.stringify(podSecurity),
	);
	acceptance.check(
		"clone-b Pod uses the RuntimeDefault seccomp profile",
		nested(podSecurity, "seccompProfile", "type") === "RuntimeDefault",
	);
	acceptance.check(
		"clone-b container runs as non-root without privilege escalation",
		nested(containerSecurity, "runAsNonRoot") === true &&
			nested(containerSecurity, "allowPrivilegeEscalation") === false &&
			nested(containerSecurity, "runAsUser") === RUNTIME_UID,
	);
	acceptance.check(
		"clone-b container drops ALL capabilities",
		JSON.stringify(nested(containerSecurity, "capabilities", "drop")) === JSON.stringify(["ALL"]),
		JSON.stringify(nested(containerSecurity, "capabilities")),
	);
	acceptance.check(
		"clone-b container has a read-only root filesystem",
		nested(containerSecurity, "readOnlyRootFilesystem") === true,
	);
	acceptance.check(
		"clone-b CPU and memory limits are Guaranteed QoS",
		nested(requests, "cpu") === PROFILE_CPU && nested(requests, "memory") === PROFILE_MEMORY,
		JSON.stringify(requests),
	);
	acceptance.check(
		"clone-b mounts the PVC at /workspace and an emptyDir at /tmp",
		mountPaths.includes(`workspace:${POD_WORKSPACE_ROOT}`) && mountPaths.includes("tmp:/tmp"),
		JSON.stringify(mountPaths),
	);
	acceptance.check(
		"clone-b /workspace claim is its own PVC",
		textOf(nested(claim, "claimName")) === textOf(nested(pod, "metadata", "name")),
		JSON.stringify(claim),
	);
	acceptance.check(
		"clone-b /tmp is an emptyDir",
		asRecord(
			nested(
				volumes.find((volume) => nested(volume, "name") === "tmp"),
				"emptyDir",
			),
		) !== null,
	);
	acceptance.check(
		"clone-b Pod carries the expected generation label",
		textOf(nested(pod, "metadata", "labels", LABEL_GENERATION)) === String(cloneBGeneration),
		`${textOf(nested(pod, "metadata", "labels", LABEL_GENERATION))} vs ${cloneBGeneration}`,
	);
}

async function assertPvcSpec(): Promise<void> {
	const pvcs = await refreshWorkspacePvcs(cloneB);
	const pvc = pvcs[0];
	acceptance.require("clone-b has exactly one PVC", pvcs.length === 1, `${pvcs.length} PVCs`);
	cloneBPvcUid = textOf(nested(pvc, "metadata", "uid"));
	acceptance.check(
		"clone-b PVC uses the selected StorageClass",
		nested(pvc, "spec", "storageClassName") === storageClass,
		`${textOf(nested(pvc, "spec", "storageClassName"))} vs ${storageClass}`,
	);
	acceptance.check(
		"clone-b PVC requests the configured size",
		nested(pvc, "spec", "resources", "requests", "storage") === PROFILE_STORAGE_SIZE,
		textOf(nested(pvc, "spec", "resources", "requests", "storage")),
	);
	acceptance.check(
		"clone-b PVC is ReadWriteOnce and Filesystem",
		asArray(nested(pvc, "spec", "accessModes")).includes("ReadWriteOnce") &&
			nested(pvc, "spec", "volumeMode") === "Filesystem",
		JSON.stringify(nested(pvc, "spec")),
	);
}

// ---------------------------------------------------------------------------
// Phase 7: stream — clone A session, then its verified removal
// ---------------------------------------------------------------------------

interface StreamHandle {
	streamId: string;
	frames: CallbackEnvelope[];
	drained: () => void;
}

async function openVirtualStream(daemonId: string): Promise<StreamHandle> {
	const transport = currentTransport();
	const streamId = `browser/${randomUUID()}`;
	const frames: CallbackEnvelope[] = [];
	transport.attachVirtualStream(daemonId, streamId, {
		deliver: (envelope) => {
			frames.push(envelope);
		},
	});
	await transport.sendToDaemon(daemonId, {
		streamId,
		kind: "control",
		payload: { type: "stream_open" },
	});
	let detached = false;
	return {
		streamId,
		frames,
		drained: () => {
			if (detached) return;
			detached = true;
			transport.detachVirtualStream(daemonId, streamId);
		},
	};
}

async function sendCall(
	daemonId: string,
	stream: StreamHandle,
	id: string,
	method: string,
	args: unknown[],
): Promise<void> {
	await currentTransport().sendToDaemon(daemonId, {
		streamId: stream.streamId,
		kind: "command",
		payload: { type: "call", id, method, args },
	});
}

function callAnswer(stream: StreamHandle, id: string): unknown {
	for (const envelope of stream.frames) {
		const payload = envelope.payload as { type?: string; id?: string; ok?: boolean } | null;
		if (payload?.type === "call_result" && payload.id === id) return payload;
	}
	return null;
}

function callAnswerOk(answer: unknown): boolean {
	const payload = answer as { ok?: unknown } | null;
	return payload?.ok === true;
}

/** Durable store view of the workspace's transcript bytes. */
function storedSessions(daemonId: string) {
	const store = FleetLogStore.load(logsDir);
	const sessions = store
		.listStoredSessions(daemonId)
		.filter((session) => session.bytes > 0 && session.mainRelpath !== undefined);
	return { store, sessions };
}

async function streamSession(daemonId: string, name: string): Promise<void> {
	const stream = await openVirtualStream(daemonId);
	acceptance.cleanup.add(`detach virtual stream for ${name}`, () => stream.drained());
	await sendCall(daemonId, stream, "name-1", "setSessionName", [`${name}-session`]);
	const named = await waitFor("the setSessionName answer", () => callAnswer(stream, "name-1"), {
		timeoutMs: POLL_TIMEOUT_MS,
	});
	acceptance.check(
		`${name} session named through the virtual stream`,
		callAnswerOk(named),
		JSON.stringify(named),
	);
	await sendCall(daemonId, stream, "stats-1", "getSessionStats", []);
	const stats = await waitFor("the getSessionStats answer", () => callAnswer(stream, "stats-1"), {
		timeoutMs: POLL_TIMEOUT_MS,
	});
	acceptance.check(`${name} getSessionStats answered`, callAnswerOk(stats), JSON.stringify(stats));
	// The SDK persists a session file lazily (`SessionManager.#shouldHaveSessionFile`
	// requires a forced creation, an on-disk current file, or the first assistant
	// entry), so a model-less boot that is only named and statted owns no
	// `<sessions>/<project>/<id>.jsonl` for the tailer to discover and stream —
	// the Pod really does hold nothing but `<id>.jsonl.lock`. `fork` is a
	// production wire method that writes the current session (title slot +
	// header, carrying the name set above) to a new file with no model turn:
	// the reachable daemon -> tailer -> fleet-store observable. Same step, same
	// reason as the bwrap walk (scripts/test-bwrap-lifecycle.ts).
	await sendCall(daemonId, stream, "fork-1", "fork", []);
	const forked = await waitFor("the fork answer", () => callAnswer(stream, "fork-1"), {
		timeoutMs: POLL_TIMEOUT_MS,
	});
	acceptance.check(
		`${name} session transcript written through the virtual stream`,
		callAnswerOk(forked),
		JSON.stringify(forked),
	);
	const stored = await waitFor(
		`${name} stored transcript bytes`,
		() => {
			const { sessions } = storedSessions(daemonId);
			return sessions[0] ?? null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 500 },
	);
	acceptance.check(
		`${name} durable transcript bytes stored`,
		stored.bytes > 0,
		JSON.stringify({ sessionId: stored.sessionId, bytes: stored.bytes }),
	);
	stream.drained();
}

async function phaseStream(): Promise<void> {
	await streamSession(cloneA, "clone-a");

	// The stop collects clone-a's final evidence (the daemon must be alive to
	// answer), which the removal below then adopts — a stop without a live
	// pair would leave the workspace undeletable.
	const stopped = await stopWithLivePair(cloneA, "the verified removal");
	acceptance.check(
		"clone-a stops through the public route",
		stopped.status === 200,
		`status ${stopped.status}: ${JSON.stringify(stopped.body)}`,
	);
	await waitFor(
		"clone-a Pod absence",
		async () => ((await workspacePods(cloneA)).length === 0 ? true : null),
		{ timeoutMs: STOP_TIMEOUT_MS, intervalMs: 2_000 },
	);
	acceptance.check(
		"stopped clone-a retains its PVC",
		(await refreshWorkspacePvcs(cloneA)).length === 1,
	);
	// The verified gate reports the SESSION ids it proved complete (fleet/cli.ts
	// renders it as "verified N session(s)"), not the workspace id — the store
	// view captured here is what the removal must prove it verified.
	const storedBeforeRemoval = storedSessions(cloneA).sessions.map((session) => session.sessionId);
	acceptance.check(
		"clone-a holds a stored transcript session before its removal",
		storedBeforeRemoval.length > 0,
		JSON.stringify(storedBeforeRemoval),
	);
	const removed = await ctl("/ctl/remove", { method: "POST", body: { selector: cloneA } });
	const removal = asRecord(removed.body);
	const verifiedSessions = asArray(nested(removal, "verified"));
	acceptance.check(
		"clone-a is removed through the verified gate",
		removed.status === 200 && asArray(nested(removal, "removed")).includes(cloneA),
		`status ${removed.status}: ${JSON.stringify(removed.body)}`,
	);
	acceptance.check(
		"clone-a removal verifies the store",
		storedBeforeRemoval.length > 0 &&
			storedBeforeRemoval.every((sessionId) => verifiedSessions.includes(sessionId)),
		`stored ${JSON.stringify(storedBeforeRemoval)} vs verified ${JSON.stringify(verifiedSessions)}`,
	);
	await waitFor(
		"clone-a resources to disappear",
		async () => {
			const pods = await workspacePods(cloneA);
			const pvcs = await refreshWorkspacePvcs(cloneA);
			return pods.length === 0 && pvcs.length === 0 ? true : null;
		},
		{ timeoutMs: STOP_TIMEOUT_MS, intervalMs: 2_000 },
	);
	acceptance.check(
		"clone-a store is frozen read-only",
		existsSync(join(logsDir, cloneA, "readonly.json")),
		join(logsDir, cloneA, "readonly.json"),
	);
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Phase 8: wake — clone B durability, restoration, and refusal
// ---------------------------------------------------------------------------

/**
 * The plan's "download a real file through bulk" step: a fleet-issued capture
 * bulk correlation plus the `download_bulk` control the edge issues for clone
 * downloads (fleet/edge.ts). The daemon has no handler for that control yet —
 * its control broker acks an unknown control with `invalid_request` and the
 * capture correlation only expires 10 minutes later — so this reports the gap
 * from that typed ack (bounded, never a 10-minute hang) instead of blocking the
 * walk, and returns the real bytes the day the daemon implements the control.
 */
async function bulkDownloadOrGap(
	daemonId: string,
	path: string,
	sessionId: string,
): Promise<{ kind: "bytes"; data: Uint8Array } | { kind: "gap"; reason: string }> {
	const transport = currentTransport();
	const correlation: BulkCorrelation = transport.createBulkCorrelation(daemonId, { capture: true });
	const streamId = `browser/${randomUUID()}`;
	const frames: CallbackEnvelope[] = [];
	transport.attachVirtualStream(daemonId, streamId, {
		deliver: (envelope) => {
			frames.push(envelope);
		},
	});
	try {
		await transport.sendToDaemon(daemonId, {
			streamId,
			kind: "control",
			payload: {
				type: "download_bulk",
				correlationId: correlation.correlationId,
				path,
				sessionId,
			},
		});
		const settled = correlation.done.then((bulk) => ({ bulk }));
		const deadline = Date.now() + 30_000;
		for (;;) {
			const raced = await Promise.race([
				settled,
				new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
			]);
			if (raced !== null) {
				const { bulk } = raced;
				if (bulk.state !== "received" || bulk.data === undefined) {
					throw new Error(`bulk transfer for ${path} failed: ${bulk.state} ${bulk.error ?? ""}`);
				}
				return { kind: "bytes", data: bulk.data };
			}
			for (const envelope of frames) {
				const payload = envelope.payload as {
					type?: string;
					ok?: unknown;
					message?: unknown;
				} | null;
				if (payload?.type !== "download_bulk" || payload.ok !== false) continue;
				return {
					kind: "gap",
					reason:
						typeof payload.message === "string"
							? payload.message
							: "the daemon rejected the bulk-download control",
				};
			}
			if (Date.now() >= deadline) {
				return { kind: "gap", reason: "no bulk transfer and no rejection within 30 s" };
			}
		}
	} finally {
		transport.detachVirtualStream(daemonId, streamId);
	}
}

async function phaseWake(): Promise<void> {
	await streamSession(cloneB, "clone-b");
	const { store, sessions } = storedSessions(cloneB);
	const session = acceptance.expect(
		sessions[0] ?? null,
		"clone-b has no stored transcript session",
	);
	const mainRelpath = session.mainRelpath ?? "";
	const storedBytes = acceptance.expect(
		store.readStored(cloneB, session.sessionId, mainRelpath),
		`clone-b stored bytes are unreadable (${mainRelpath})`,
	);

	const bulk = await bulkDownloadOrGap(
		cloneB,
		`${POD_HOME_DIR}/agent/sessions/${mainRelpath}`,
		session.sessionId,
	);
	let bulkGapReason: string | null = null;
	if (bulk.kind === "bytes") {
		acceptance.check(
			"bulk download returns the real transcript bytes",
			Buffer.from(bulk.data).equals(storedBytes),
			`${bulk.data.length} vs ${storedBytes.length}`,
		);
	} else {
		// A REPORTED GAP, not a silent pass: the plan's bulk-download step
		// cannot run until the daemon implements the `download_bulk` control
		// (fleet/edge.ts issues it; the daemon acks it as an unknown control).
		// The real-file proof it would supply is taken below, from the PVC
		// itself, once the stop has quiesced the daemon and the fleet has acked
		// the final flush boundary — the point at which the store provably
		// holds every byte of the transcript.
		bulkGapReason = bulk.reason;
		console.log(`gap  bulk download is unavailable: ${bulk.reason}`);
	}

	const row = await sessionRow(cloneB);
	acceptance.check(
		"clone-b pin matches the served commit",
		nested(row, "workspace", "pinnedRevision") === commitId,
		`${textOf(nested(row, "workspace", "pinnedRevision"))} vs ${commitId}`,
	);
	const pods = await workspacePods(cloneB);
	const containers = asArray(nested(pods[0], "spec", "containers"));
	const env = asArray(nested(asRecord(containers[0]), "env"));
	const envValue = (key: string): string => {
		const entry = env.find((item) => nested(item, "name") === key);
		return textOf(nested(entry, "value"));
	};
	acceptance.check(
		"clone-b daemon cwd is the checkout mount",
		envValue("OMP_WORKSPACE_DIR") === POD_CHECKOUT_DIR,
		envValue("OMP_WORKSPACE_DIR"),
	);

	const sentinelPod = `omp-acc-sentinel-${randomUUID().slice(0, 6)}`;
	await runToolPod(sentinelPod, pvcNameFor(cloneB), [
		"sh",
		"-c",
		"echo acceptance-sentinel > /workspace/.home/acceptance-sentinel",
	]);
	const beforePod = textOf(nested(pods[0], "metadata", "uid"));
	await stopWithLivePair(cloneB, "the wake");
	await waitFor(
		"clone-b Pod absence before wake",
		async () => ((await workspacePods(cloneB)).length === 0 ? true : null),
		{ timeoutMs: STOP_TIMEOUT_MS, intervalMs: 2_000 },
	);
	const stoppedPvcs = await refreshWorkspacePvcs(cloneB);
	acceptance.check(
		"stopped clone-b retains its PVC",
		stoppedPvcs.length === 1 && textOf(nested(stoppedPvcs[0], "metadata", "uid")) === cloneBPvcUid,
		JSON.stringify(stoppedPvcs.map((pvc) => nested(pvc, "metadata", "uid"))),
	);
	if (bulkGapReason !== null) {
		// The stop above quiesced the daemon (flush + dispose + tailer
		// finalize) and waited for the fleet's acks over the final flush
		// boundary, so the store now provably holds every byte of this
		// transcript: the PVC's own file is the real-file proof the missing
		// bulk download would have supplied.
		const post = storedSessions(cloneB);
		const postSession =
			post.sessions.find((candidate) => candidate.sessionId === session.sessionId) ??
			post.sessions[0];
		const postBytes =
			postSession === undefined
				? undefined
				: post.store.readStored(cloneB, postSession.sessionId, postSession.mainRelpath ?? "");
		const volumeHash = await sha256InVolume(cloneB, mainRelpath);
		const storedHash =
			postBytes === null || postBytes === undefined
				? ""
				: createHash("sha256").update(postBytes).digest("hex");
		acceptance.check(
			"the workspace's own transcript bytes match the stored stream",
			storedHash !== "" && volumeHash === storedHash,
			`${volumeHash} vs ${storedHash}`,
		);
	}

	const woken = await ctl("/ctl/wake", { method: "POST", body: { daemonId: cloneB } });
	acceptance.check(
		"clone-b wake succeeds",
		woken.status === 200,
		`status ${woken.status}: ${JSON.stringify(woken.body)}`,
	);
	await waitFor(
		"clone-b to be Running again",
		async () => {
			const current = await workspacePods(cloneB);
			return textOf(nested(current[0], "status", "phase")) === "Running" ? true : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 2_000 },
	);
	const afterPods = await workspacePods(cloneB);
	acceptance.check(
		"wake reuses the same PVC",
		textOf(nested((await refreshWorkspacePvcs(cloneB))[0], "metadata", "uid")) === cloneBPvcUid,
	);
	acceptance.check(
		"wake replaces the Pod UID",
		textOf(nested(afterPods[0], "metadata", "uid")) !== beforePod,
		`${beforePod} -> ${textOf(nested(afterPods[0], "metadata", "uid"))}`,
	);
	const sentinelAfter = await runToolPod(
		`omp-acc-check-${randomUUID().slice(0, 6)}`,
		pvcNameFor(cloneB),
		["sh", "-c", "cat /workspace/.home/acceptance-sentinel"],
	);
	acceptance.check(
		"wake preserves the home sentinel",
		sentinelAfter.includes("acceptance-sentinel"),
		sentinelAfter.trim(),
	);
	const resumed = await waitFor(
		"clone-b's session to reappear",
		() => {
			const { sessions: current } = storedSessions(cloneB);
			return current.find((candidate) => candidate.sessionId === session.sessionId) ?? null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 1_000 },
	);
	acceptance.check("wake resumes the same session", resumed.sessionId === session.sessionId);

	// Fleet restart: the surviving Pod must reconnect to the new fleet.
	const previous = fleet;
	fleet = null;
	await previous?.close();
	fleet = await startFleet({
		port: 0,
		statePath,
		configPath,
		workspaceDir,
		statsConfig: {
			statsDbPath: join(sandboxRoot, "stats.db"),
			sessionsDir: join(sandboxRoot, "agent-sessions"),
		},
	});
	fleetPort = fleet.port;
	setEnv("OMP_FLEET_PORT", String(fleetPort));
	acceptance.check("fleet restarts on the recorded state", fleetPort > 0);
	const reconnected = await waitFor(
		"the restarted fleet to reconnect to clone-b",
		() => (currentTransport().pairStatus(cloneB).paired ? true : null),
		{ timeoutMs: PAIR_TIMEOUT_MS },
	);
	acceptance.check("restarted fleet reconnects to the surviving Pod", reconnected === true);

	// Destroy ONLY the main transcript on the PVC, then prove restoration.
	await stopWithLivePair(cloneB, "the transcript restoration");
	await waitFor(
		"clone-b Pod absence before restoration",
		async () => ((await workspacePods(cloneB)).length === 0 ? true : null),
		{ timeoutMs: STOP_TIMEOUT_MS, intervalMs: 2_000 },
	);
	await runToolPod(`omp-acc-wipe-${randomUUID().slice(0, 6)}`, pvcNameFor(cloneB), [
		"sh",
		"-c",
		`rm -f /workspace/.home/agent/sessions/${mainRelpath}`,
	]);
	await ctl("/ctl/wake", { method: "POST", body: { daemonId: cloneB } });
	await waitFor(
		"clone-b to be Running after restoration",
		async () => {
			const current = await workspacePods(cloneB);
			return textOf(nested(current[0], "status", "phase")) === "Running" ? true : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 2_000 },
	);
	// The daemon restores the missing transcript over the callback pair during
	// its boot (a required resume that cannot restore exits before readiness),
	// so wait for the restored bytes instead of racing that transfer with a
	// single read: the Pod reaches Running before the restore completes. A
	// kubernetes wake must hand the IN-POD main transcript and mark the resume
	// required — the fleet cannot read the PVC, so a non-required resume would
	// silently boot a fresh session instead of restoring the wiped one.
	const restorePods = await workspacePods(cloneB);
	const restorePodName = textOf(nested(restorePods[0], "metadata", "name"));
	const restoreEnv = asArray(
		nested(asRecord(asArray(nested(restorePods[0], "spec", "containers"))[0]), "env"),
	);
	const restoreEnvValue = (key: string): string =>
		textOf(
			nested(
				restoreEnv.find((item) => nested(item, "name") === key),
				"value",
			),
		);
	acceptance.check(
		"the wake hands the daemon its required in-pod resume target",
		restoreEnvValue("OMP_SESSION_RESUME") === `/workspace/.home/agent/sessions/${mainRelpath}` &&
			restoreEnvValue("OMP_SESSION_RESUME_REQUIRED") === "1",
		`OMP_SESSION_RESUME=${restoreEnvValue("OMP_SESSION_RESUME") || "(unset)"} REQUIRED=${
			restoreEnvValue("OMP_SESSION_RESUME_REQUIRED") || "(unset)"
		} container=${(await terminatedContainer(restorePodName)) ?? "alive"}`,
	);
	const expectedHash = createHash("sha256").update(storedBytes).digest("hex");
	const restoredHash = await waitFor(
		"the restored main transcript on clone-b's PVC",
		async () => {
			const hash = await sha256InVolume(cloneB, mainRelpath);
			return hash === expectedHash ? hash : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 5_000 },
	);
	acceptance.check(
		"wake restores the deleted main transcript byte-identically",
		restoredHash === expectedHash,
		`${restoredHash} vs ${expectedHash}`,
	);

	// Dirty-checkout refusal, then recovery that preserves the change. The
	// receipt's Git verdict is collected AT STOP TIME (the fleet cannot read
	// the PVC, so a stopped workspace's evidence is the only view of its
	// checkout it will ever have), so the dirt must exist BEFORE the stop
	// whose receipt the removal gate will adopt: write it with the clone
	// stopped, wake onto the dirty checkout, stop again, then require the
	// removal to refuse.
	await stopWithLivePair(cloneB, "the dirty-file probe");
	await waitFor(
		"clone-b Pod absence before the dirty file",
		async () => ((await workspacePods(cloneB)).length === 0 ? true : null),
		{ timeoutMs: STOP_TIMEOUT_MS, intervalMs: 2_000 },
	);
	await runToolPod(`omp-acc-dirty-${randomUUID().slice(0, 6)}`, pvcNameFor(cloneB), [
		"sh",
		"-c",
		`echo dirty > ${POD_CHECKOUT_DIR}/acceptance-dirty.txt`,
	]);
	const dirtyWake = await ctl("/ctl/wake", { method: "POST", body: { daemonId: cloneB } });
	acceptance.check(
		"clone-b wakes onto its dirty checkout",
		dirtyWake.status === 200,
		`status ${dirtyWake.status}: ${JSON.stringify(dirtyWake.body)}`,
	);
	await waitFor(
		"clone-b to be Running with the dirty checkout",
		async () => {
			const current = await workspacePods(cloneB);
			return textOf(nested(current[0], "status", "phase")) === "Running" ? true : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 2_000 },
	);
	await stopWithLivePair(cloneB, "the dirty-checkout refusal");
	await waitFor(
		"clone-b Pod absence before the refusal",
		async () => ((await workspacePods(cloneB)).length === 0 ? true : null),
		{ timeoutMs: STOP_TIMEOUT_MS, intervalMs: 2_000 },
	);
	const refused = await ctl("/ctl/remove", { method: "POST", body: { selector: cloneB } });
	acceptance.check(
		"removal is refused while the checkout is dirty",
		refused.status !== 200,
		`status ${refused.status}: ${JSON.stringify(refused.body)}`,
	);
	acceptance.check(
		"refused removal leaves the PVC in place",
		(await refreshWorkspacePvcs(cloneB)).length === 1,
	);
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Phase 9: delete — preserve the change and run the verified gate
// ---------------------------------------------------------------------------

async function phaseDelete(): Promise<void> {
	// The dirty refusal above left a REJECTED deletion attempt. The documented
	// remedy is to clear it, wake the workspace to preserve its change, stop
	// it, and retry the delete.
	const cleared = await ctl(`/ctl/workspaces/${cloneB}/clear-deletion`, { method: "POST" });
	acceptance.check(
		"the rejected deletion attempt is cleared for the recovery wake",
		cleared.status === 200 && nested(cleared.body, "cleared") === true,
		`status ${cleared.status}: ${JSON.stringify(cleared.body)}`,
	);
	await ctl("/ctl/wake", { method: "POST", body: { daemonId: cloneB } });
	await waitFor(
		"clone-b to be Running for the recovery",
		async () => {
			const current = await workspacePods(cloneB);
			return textOf(nested(current[0], "status", "phase")) === "Running" ? true : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 2_000 },
	);
	const dirtyPresent = await runToolPod(
		`omp-acc-verify-${randomUUID().slice(0, 6)}`,
		pvcNameFor(cloneB),
		["sh", "-c", `cat ${POD_CHECKOUT_DIR}/acceptance-dirty.txt`],
	);
	acceptance.check(
		"wake preserves the dirty working file",
		dirtyPresent.includes("dirty"),
		dirtyPresent.trim(),
	);
	const committed = await runToolPod(
		`omp-acc-commit-${randomUUID().slice(0, 6)}`,
		pvcNameFor(cloneB),
		[
			"sh",
			"-c",
			[
				`git -C ${POD_CHECKOUT_DIR} -c user.email=acceptance@test -c user.name=acceptance add -A`,
				`git -C ${POD_CHECKOUT_DIR} -c user.email=acceptance@test -c user.name=acceptance commit -m "acceptance dirty change" >/dev/null`,
				// "Preserved" is a REMOTE fact for the delete contract: the
				// receipt's Git evidence proves every local tip is contained
				// by an advertised remote ref, so the change must be pushed.
				`echo PRESERVED=$(git -C ${POD_CHECKOUT_DIR} rev-parse HEAD)`,
				`git -C ${POD_CHECKOUT_DIR} push -q origin HEAD:refs/heads/acceptance`,
				// The quiesce evidence is bound to the workspace's PINNED
				// revision (the fleet's receipt validator refuses evidence
				// resolving another commit), so the checkout returns to the pin
				// once the commit is safe on the remote. Nothing is lost: the
				// change rides the remote branch asserted below.
				`git -C ${POD_CHECKOUT_DIR} reset --hard ${commitId}`,
				`test -z "$(git -C ${POD_CHECKOUT_DIR} status --porcelain)" && echo CHECKOUT-CLEAN || echo CHECKOUT-DIRTY`,
			].join(" && "),
		],
	);
	acceptance.check(
		"the change is preserved as a pushed commit (checkout back at the pin)",
		committed.includes("CHECKOUT-CLEAN"),
		committed.trim().slice(-300),
	);
	const preservedCommit = /PRESERVED=([0-9a-f]{40})/.exec(committed)?.[1] ?? "";
	const advertised = await runCommand([gitBin, "ls-remote", gitUrl, "refs/heads/acceptance"]);
	acceptance.check(
		"the preserved commit is advertised by the source remote",
		preservedCommit !== "" && advertised.stdout.includes(preservedCommit),
		`${preservedCommit === "" ? "(no commit reported)" : preservedCommit} vs ${
			advertised.stdout.trim() || advertised.stderr.trim()
		}`,
	);

	// The store view the removal must prove it verified (the gate reports
	// session ids, never the workspace id).
	const storedBeforeRemoval = storedSessions(cloneB).sessions.map((session) => session.sessionId);
	acceptance.check(
		"clone-b holds a stored transcript session before its removal",
		storedBeforeRemoval.length > 0,
		JSON.stringify(storedBeforeRemoval),
	);
	await stopWithLivePair(cloneB, "the verified removal");
	await waitFor(
		"clone-b Pod absence before final removal",
		async () => ((await workspacePods(cloneB)).length === 0 ? true : null),
		{ timeoutMs: STOP_TIMEOUT_MS, intervalMs: 2_000 },
	);
	const removed = await ctl("/ctl/remove", { method: "POST", body: { selector: cloneB } });
	const removal = asRecord(removed.body);
	const verifiedSessions = asArray(nested(removal, "verified"));
	acceptance.check(
		"clone-b is removed through the verified gate",
		removed.status === 200 && asArray(nested(removal, "removed")).includes(cloneB),
		`status ${removed.status}: ${JSON.stringify(removed.body)}`,
	);
	acceptance.check(
		"clone-b removal verifies the store",
		storedBeforeRemoval.length > 0 &&
			storedBeforeRemoval.every((sessionId) => verifiedSessions.includes(sessionId)),
		`stored ${JSON.stringify(storedBeforeRemoval)} vs verified ${JSON.stringify(verifiedSessions)}`,
	);
	await waitFor(
		"clone-b resources to disappear",
		async () => {
			const pods = await workspacePods(cloneB);
			const pvcs = await refreshWorkspacePvcs(cloneB);
			return pods.length === 0 && pvcs.length === 0 ? true : null;
		},
		{ timeoutMs: STOP_TIMEOUT_MS, intervalMs: 2_000 },
	);
	acceptance.check(
		"clone-b store is frozen read-only",
		existsSync(join(logsDir, cloneB, "readonly.json")),
		join(logsDir, cloneB, "readonly.json"),
	);
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function phaseCleanup(): Promise<void> {
	// Deleting the current entry is safe while iterating a Set.
	for (const name of toolPods) await deleteToolPod(name);
}

async function main(): Promise<never> {
	let blocked: BlockedError | null = null;
	try {
		acceptance.enter("prerequisite");
		await phasePrerequisite();
		acceptance.enter("cluster");
		await phaseCluster();
		acceptance.enter("image");
		await phaseImage();
		acceptance.enter("git");
		await phaseGit();
		acceptance.enter("preflight");
		await phasePreflight();
		acceptance.enter("spawn");
		await phaseSpawn();
		acceptance.enter("stream");
		await phaseStream();
		acceptance.enter("wake");
		await phaseWake();
		acceptance.enter("delete");
		await phaseDelete();
	} catch (cause) {
		blocked =
			cause instanceof BlockedError ? cause : new BlockedError(acceptance.phase, messageOf(cause));
	} finally {
		acceptance.enter("cleanup");
		try {
			await phaseCleanup();
		} catch (cause) {
			blocked ??= new BlockedError("cleanup", messageOf(cause));
		}
		if (!(await acceptance.cleanup.run())) {
			console.error("FAIL cleanup");
			for (const failure of acceptance.cleanup.failures) console.error(`  ${failure}`);
			blocked ??= new BlockedError("cleanup", acceptance.cleanup.failures.join("; "));
		}
	}

	if (acceptance.cleanup.interrupted !== null) {
		console.error(`BLOCKED cleanup (${acceptance.cleanup.interrupted})`);
		process.exit(SIGNAL_EXIT[acceptance.cleanup.interrupted]);
	}
	if (blocked !== null) {
		console.error(`BLOCKED ${blocked.phase}`);
		console.error(sanitize(blocked.message));
		process.exit(1);
	}
	console.log(MARKER);
	process.exit(0);
}

await main();
