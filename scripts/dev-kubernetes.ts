#!/usr/bin/env bun
/**
 * dev-kubernetes — bring up the HOST side of the Kubernetes worker lifecycle
 * so the operator can drive real clones through the real UI.
 *
 * It owns the cluster, namespace, and `OMP_KUBE_BIN` wrapper; the base and
 * CA-trusting derived session-runtime images; the throwaway gateway TLS and
 * gateway source; and the seed Git project with a `git://` bare remote. It
 * never starts a long-lived process: the gateway, fleet, UI, and `git daemon`
 * belong to the operator's `hub` process table, and the exact environment
 * they need is written to `<dev-root>/env.json` and printed at the end.
 *
 * Re-runnable: every step is existence-checked, so a second run is a no-op.
 *
 * Usage:
 *   bun scripts/dev-kubernetes.ts                 bring up / reconcile
 *   bun scripts/dev-kubernetes.ts --check         verify only; never writes
 *   bun scripts/dev-kubernetes.ts --probe-gateway throwaway-Pod gateway dial
 *   bun scripts/dev-kubernetes.ts --help
 *
 * `--check` still runs the Pod-reachability probe (one throwaway Pod, created
 * and removed); pass `--no-probe` to skip even that.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));
const DEV_ROOT = process.env.OMP_DEV_KUBE_ROOT ?? "/tmp/omp-dev-kube";
const CHECK_ONLY = process.argv.includes("--check");
const PROBE_GATEWAY = process.argv.includes("--probe-gateway");
const NO_PROBE = process.argv.includes("--no-probe");

/** Fixed dev identity. One cluster, one namespace, one wrapper, one port set. */
const PROFILE = "omp-dev";
const NAMESPACE = "omp-clones";
const PROXY_PORT = 4743;
const GIT_PORT = 4744;
const FLEET_PORT = 4722;
const UI_PORT = 4713;
const BASE_IMAGE = "omp-web-dev:omp-dev";
const CA_IMAGE = "omp-web-dev-ca:omp-dev";

const BIND_ADDRESS = "0.0.0.0";
const RUNTIME_UID = 10001;
const POD_WORKSPACE_ROOT = "/workspace";

const PROFILE_CPU = "500m";
const PROFILE_MEMORY = "512Mi";
const PROFILE_STORAGE_SIZE = "1Gi";

const MANIFEST_LABEL = "omp-web.omp.dev/dev-tool";
const GATEWAY_REJECTED_BODY = "omp-dev-gateway-rejected";

const DEFAULT_DOCKER_SOCKET = "unix:///var/run/docker.sock";

const SUBPROCESS_TIMEOUT_MS = 180_000;
const CLUSTER_TIMEOUT_MS = 900_000;
const CLUSTER_READY_TIMEOUT_MS = 300_000;
const BUILD_TIMEOUT_MS = 900_000;
const POLL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 300_000;
const PORT_PROBE_TIMEOUT_MS = 5_000;
/** Renew the gateway certificate once it is within this window of expiry. */
const CERT_RENEWAL_WINDOW_S = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Paths under the dev root
// ---------------------------------------------------------------------------

const paths = {
	root: DEV_ROOT,
	bin: join(DEV_ROOT, "bin"),
	kubeBin: join(DEV_ROOT, "bin", "kubectl"),
	runtimeBin: join(DEV_ROOT, "bin", "bun"),
	minikubeHome: join(DEV_ROOT, "minikube-home"),
	kubeconfig: join(DEV_ROOT, "kubeconfig"),
	workspaces: join(DEV_ROOT, "workspaces"),
	seedProject: join(DEV_ROOT, "seed-project"),
	gitRoot: join(DEV_ROOT, "git"),
	tls: join(DEV_ROOT, "tls"),
	derivedContext: join(DEV_ROOT, "derived-image"),
	imageStamp: join(DEV_ROOT, "image-stamp.json"),
	manifests: join(DEV_ROOT, "manifests"),
	config: join(DEV_ROOT, "config.json"),
	state: join(DEV_ROOT, "fleet-state.json"),
	env: join(DEV_ROOT, "env.json"),
	gateway: join(DEV_ROOT, "gateway.ts"),
	stop: join(DEV_ROOT, "stop.sh"),
};

// ---------------------------------------------------------------------------
// Logging + process helpers
// ---------------------------------------------------------------------------

function log(message: string): void {
	console.log(`dev-kubernetes: ${message}`);
}

function die(message: string): never {
	console.error(`dev-kubernetes: FAIL ${message}`);
	process.exit(1);
}

interface CommandResult {
	code: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

function scriptEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	return env;
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
	const intervalMs = opts.intervalMs ?? 500;
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
// Generated files
// ---------------------------------------------------------------------------

/**
 * Reconcile mode writes `content`. `--check` must not mutate anything, so it
 * reports missing or stale content instead (byte-exact; these files are all
 * deterministic functions of the resolved facts).
 */
function installFile(path: string, content: string, mode?: number): void {
	if (CHECK_ONLY) {
		if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
			die(`${path} is missing or stale; re-run without --check to reconcile`);
		}
		if (mode !== undefined && (statSync(path).mode & 0o777) !== mode) {
			die(`${path} has the wrong permissions; re-run without --check to reconcile`);
		}
		return;
	}
	writeFileSync(path, content);
	if (mode !== undefined) chmodSync(path, mode);
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

function shellQuote(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Tool resolution + Docker endpoint
// ---------------------------------------------------------------------------

const tools = {
	minikube: "",
	docker: "",
	git: "",
	openssl: "",
	bun: "",
	dockerHost: "",
};

function resolveTools(): void {
	tools.minikube = resolveTool("minikube") ?? "";
	tools.docker = resolveTool("docker") ?? "";
	tools.git = resolveTool("git") ?? "";
	tools.openssl = resolveTool("openssl") ?? "";
	// The runtime under test is the Bun this script runs under.
	tools.bun = realpathSync(process.execPath);
	for (const [name, value] of Object.entries(tools)) {
		if (name === "dockerHost") continue;
		if (value === "") die(`${name} is not on PATH`);
	}
}

/**
 * The local Docker endpoint, resolved from an inherited `DOCKER_HOST`, the
 * ACTIVE docker context, then the default socket. This host runs ROOTLESS
 * Docker whose socket the `default` context does not name, so the context
 * lookup (not the fallback) is what makes the docker driver work.
 */
async function resolveDockerEndpoint(): Promise<string> {
	const inherited = process.env.DOCKER_HOST;
	if (inherited !== undefined && inherited !== "") return inherited;
	const context = await runCommand([
		tools.docker,
		"context",
		"inspect",
		"--format",
		"{{.Endpoints.docker.Host}}",
	]);
	const endpoint = context.stdout.trim();
	if (context.code === 0 && endpoint !== "") return endpoint;
	return DEFAULT_DOCKER_SOCKET;
}

// ---------------------------------------------------------------------------
// Environment for every cluster-side subprocess
// ---------------------------------------------------------------------------

/**
 * The environment the cluster-side tooling runs under: an isolated minikube
 * home + kubeconfig (so `omp-dev` can never collide with an operator profile
 * or ambient kubeconfig), the pinned rootless Docker socket, and no ambient
 * Docker/BuildKit context selector. HOME is deliberately NOT overridden: the
 * long-lived fleet needs the operator's agent/config state to stay usable.
 */
function clusterEnv(): Record<string, string> {
	const env: Record<string, string> = {
		...scriptEnv(),
		MINIKUBE_HOME: paths.minikubeHome,
		MINIKUBE_IN_STYLE: "false",
		MINIKUBE_WANTUPDATENOTIFICATION: "false",
		KUBECONFIG: paths.kubeconfig,
		DOCKER_HOST: tools.dockerHost,
		DOCKER_BUILDKIT: "1",
	};
	delete env.DOCKER_CONTEXT;
	delete env.BUILDKIT_HOST;
	delete env.DOCKER_BUILDKIT_HOST;
	return env;
}

/**
 * Every minikube invocation is pinned to the dev profile: the profile is not
 * optional (`minikube image load` defaults to the `minikube` profile and dies
 * with `cluster "minikube" does not exist`).
 */
async function minikube(args: readonly string[], timeoutMs = CLUSTER_TIMEOUT_MS) {
	return runCommand([tools.minikube, "-p", PROFILE, ...args], { env: clusterEnv(), timeoutMs });
}

async function kube(args: readonly string[], timeoutMs = SUBPROCESS_TIMEOUT_MS) {
	return runCommand([paths.kubeBin, ...args], { env: clusterEnv(), timeoutMs });
}

async function kubeJson(
	args: readonly string[],
	timeoutMs = SUBPROCESS_TIMEOUT_MS,
): Promise<unknown> {
	const result = await kube(args, timeoutMs);
	if (result.code !== 0) {
		throw new Error(
			`kubectl ${args.join(" ")} failed (${result.code}): ${result.stderr.slice(-300)}`,
		);
	}
	return result.stdout.trim() === "" ? null : JSON.parse(result.stdout);
}

// ---------------------------------------------------------------------------
// git bundle freshness
// ---------------------------------------------------------------------------

/**
 * Whether `dist-bundle/` is missing or older than the sources that feed it.
 * `server/embedded-dist.ts` and `package.json` are excluded: the build
 * regenerates and then restores both, so their mtimes are always NEWER than
 * the bundle even on a fresh build.
 */
function distBundleStaleness(): string | null {
	const bundle = join(REPO_ROOT, "dist-bundle", "cli.js");
	const imageContext = join(REPO_ROOT, "dist-bundle", "image", "Containerfile");
	if (!existsSync(bundle)) return "dist-bundle/cli.js is missing";
	if (!existsSync(imageContext)) return "dist-bundle/image/ is missing";
	let bundleMtime: number;
	try {
		bundleMtime = statSync(bundle).mtimeMs;
	} catch {
		return "dist-bundle/cli.js is unreadable";
	}
	const excluded = new Set(["embedded-dist.ts"]);
	for (const dir of ["server", "shared", "runtime", "fleet", "cli"]) {
		const root = join(REPO_ROOT, dir);
		if (!existsSync(root)) continue;
		for (const file of walkFiles(root)) {
			if (excluded.has(file.split("/").pop() ?? "")) continue;
			if (statSync(file).mtimeMs > bundleMtime) {
				return `${file.slice(REPO_ROOT.length + 1)} is newer than dist-bundle/cli.js`;
			}
		}
	}
	return null;
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walkFiles(full));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

async function ensureBundle(): Promise<void> {
	const stale = distBundleStaleness();
	if (stale === null) {
		log("dist-bundle/ is current");
		return;
	}
	if (CHECK_ONLY) die(`dist-bundle/ is stale (${stale}); re-run without --check to rebuild`);
	log(`building dist-bundle/ (${stale})`);
	const build = await runCommand([tools.bun, "run", "build"], {
		cwd: REPO_ROOT,
		env: clusterEnv(),
		timeoutMs: BUILD_TIMEOUT_MS,
	});
	if (build.code !== 0) die(`bun run build failed: ${build.stderr.slice(-500)}`);
	for (const artifact of [
		join(REPO_ROOT, "dist-bundle", "cli.js"),
		join(REPO_ROOT, "dist-bundle", "providers", "bwrap-provider.js"),
		join(REPO_ROOT, "dist-bundle", "providers", "kubernetes-provider.js"),
		join(REPO_ROOT, "dist-bundle", "image", "Containerfile"),
	]) {
		if (!existsSync(artifact)) die(`build did not produce ${artifact}`);
	}
}

// ---------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------

/**
 * Bring the dev profile up. Every step is existence-checked, so the second run
 * of this script only observes. In `--check` mode a missing cluster is a
 * failure, never a start.
 */
async function ensureCluster(): Promise<string> {
	if (!CHECK_ONLY) {
		mkdirSync(paths.minikubeHome, { recursive: true });
		mkdirSync(paths.bin, { recursive: true });
	}
	installKubeWrapper();

	const status = await minikube(["status", "--format", "{{.Host}}"], 120_000);
	const running = status.code === 0 && status.stdout.includes("Running");
	if (!running) {
		if (CHECK_ONLY)
			die(
				`minikube profile ${PROFILE} is not running (${status.stdout.trim() || status.stderr.trim()})`,
			);
		log(`starting minikube profile ${PROFILE} (docker driver)`);
		const start = await minikube(["start", "--driver=docker", "--wait=all", "--interactive=false"]);
		if (start.code !== 0) {
			die(`minikube start failed: ${start.stderr.slice(-500) || start.stdout.slice(-500)}`);
		}
	} else {
		log(`minikube profile ${PROFILE} is running`);
	}

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

	const existingNs = await kube([
		"get",
		"namespace",
		NAMESPACE,
		"--ignore-not-found",
		"-o",
		"name",
	]);
	if (existingNs.stdout.trim() === "") {
		if (CHECK_ONLY) die(`namespace ${NAMESPACE} is missing`);
		const createNs = await kube(["create", "namespace", NAMESPACE]);
		if (createNs.code !== 0) {
			die(`creating namespace ${NAMESPACE} failed: ${createNs.stderr.slice(-300)}`);
		}
		log(`created namespace ${NAMESPACE}`);
	} else {
		log(`namespace ${NAMESPACE} exists`);
	}

	const context = (await kube(["config", "current-context"])).stdout.trim();
	if (context === "") die("the isolated kubeconfig has no current context");
	return context;
}

/**
 * The temporary `OMP_KUBE_BIN` wrapper: this host has NO ambient kubectl, so
 * every provider/preflight invocation must go through
 * `minikube -p <profile> kubectl --`. The cluster selectors are baked in so
 * the wrapper is self-sufficient even for a spawn that passes no env.
 */
function installKubeWrapper(): void {
	const script =
		`#!/bin/sh\n` +
		`MINIKUBE_HOME=${shellQuote(paths.minikubeHome)} ` +
		`KUBECONFIG=${shellQuote(paths.kubeconfig)} ` +
		`DOCKER_HOST=${shellQuote(tools.dockerHost)} ` +
		`MINIKUBE_IN_STYLE=false ` +
		`exec ${shellQuote(tools.minikube)} -p ${shellQuote(PROFILE)} kubectl -- "$@"\n`;
	installFile(paths.kubeBin, script, 0o755);
}

async function storageClassName(): Promise<string> {
	const classes = asArray(nested(await kubeJson(["get", "storageclass", "-o", "json"]), "items"));
	const chosen =
		classes.find(
			(item) =>
				nested(
					asRecord(item),
					"metadata",
					"annotations",
					"storageclass.kubernetes.io/is-default-class",
				) === "true",
		) ?? classes[0];
	const name = textOf(nested(chosen, "metadata", "name"));
	if (name === "") {
		die(
			`the cluster exposes no StorageClass: ${JSON.stringify(
				classes.map((item) => nested(item, "metadata", "name")),
			)}`,
		);
	}
	return name;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * A deterministic digest of each image's build inputs, written beside the dev
 * root. The fixed tags alone would keep a stale image whenever the runtime
 * bundle or the throwaway CA changed under the same tag.
 */
interface ImageStamp {
	base: string;
	derived: string;
}

function readImageStamp(): ImageStamp {
	const empty: ImageStamp = { base: "", derived: "" };
	if (!existsSync(paths.imageStamp)) return empty;
	try {
		const record = asRecord(JSON.parse(readFileSync(paths.imageStamp, "utf8")));
		return { base: textOf(nested(record, "base")), derived: textOf(nested(record, "derived")) };
	} catch {
		return empty;
	}
}

function writeImageStamp(stamp: ImageStamp): void {
	writeFileSync(paths.imageStamp, `${JSON.stringify(stamp, null, 2)}\n`);
}

/** Deterministic content digest of a tree: relative path + bytes, sorted. */
function treeDigest(dir: string): string {
	const hash = new Bun.CryptoHasher("sha256");
	for (const file of walkFiles(dir).sort()) {
		hash.update(file.slice(dir.length + 1));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/** The base image build context is its own complete input set. */
function baseImageDigest(): string {
	return treeDigest(join(REPO_ROOT, "dist-bundle", "image"));
}

/** Throwaway CA bytes; empty until the TLS material is generated. */
function caDigest(): string {
	const ca = join(paths.tls, "ca.crt");
	return existsSync(ca)
		? new Bun.CryptoHasher("sha256").update(readFileSync(ca)).digest("hex")
		: "";
}

function derivedImageDigest(base: string): string {
	const hash = new Bun.CryptoHasher("sha256");
	hash.update(base);
	hash.update("\0");
	hash.update(caDigest());
	return hash.digest("hex");
}

async function imagePresentInProfile(tag: string): Promise<boolean> {
	const listed = await minikube(["image", "ls"], 180_000);
	return listed.stdout.includes(tag);
}

async function ensureBaseImage(): Promise<string> {
	const digest = baseImageDigest();
	if (readImageStamp().base === digest && (await imagePresentInProfile(BASE_IMAGE))) {
		log(`base image ${BASE_IMAGE} is current`);
		return digest;
	}
	if (CHECK_ONLY) {
		die(`base image ${BASE_IMAGE} is missing or stale; re-run without --check to rebuild`);
	}
	log(`building ${BASE_IMAGE} from dist-bundle/image/`);
	const built = await runCommand(
		[
			tools.docker,
			"build",
			"--file",
			join(REPO_ROOT, "dist-bundle", "image", "Containerfile"),
			"--tag",
			BASE_IMAGE,
			join(REPO_ROOT, "dist-bundle", "image"),
		],
		{ env: clusterEnv(), timeoutMs: BUILD_TIMEOUT_MS },
	);
	if (built.code !== 0) die(`image build failed: ${built.stderr.slice(-600)}`);
	const loaded = await minikube(["image", "load", BASE_IMAGE], BUILD_TIMEOUT_MS);
	if (loaded.code !== 0) die(`minikube image load failed: ${loaded.stderr.slice(-400)}`);
	writeImageStamp({ ...readImageStamp(), base: digest });
	log(`loaded ${BASE_IMAGE} into the profile`);
	return digest;
}

async function ensureDerivedImage(base: string): Promise<void> {
	const digest = derivedImageDigest(base);
	if (readImageStamp().derived === digest && (await imagePresentInProfile(CA_IMAGE))) {
		log(`derived image ${CA_IMAGE} is current`);
		return;
	}
	if (CHECK_ONLY) {
		die(`derived image ${CA_IMAGE} is missing or stale; re-run without --check to rebuild`);
	}
	log(`building ${CA_IMAGE} (trusts the throwaway CA, runs as ${RUNTIME_UID})`);
	const built = await runCommand([tools.docker, "build", "--tag", CA_IMAGE, paths.derivedContext], {
		env: clusterEnv(),
		timeoutMs: BUILD_TIMEOUT_MS,
	});
	if (built.code !== 0) die(`derived image build failed: ${built.stderr.slice(-600)}`);
	const loaded = await minikube(["image", "load", CA_IMAGE], BUILD_TIMEOUT_MS);
	if (loaded.code !== 0) die(`minikube image load failed: ${loaded.stderr.slice(-400)}`);
	writeImageStamp({ ...readImageStamp(), derived: digest });
	log(`loaded ${CA_IMAGE} into the profile`);
}

// ---------------------------------------------------------------------------
// Reachability: which address can a Pod dial back to this VM?
// ---------------------------------------------------------------------------

interface ReachProbe {
	address: string;
	detail: string;
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

async function podReachableCandidates(): Promise<string[]> {
	const candidates: string[] = [];
	const add = (value: string): void => {
		if (value !== "" && !candidates.includes(value)) candidates.push(value);
	};
	for (const address of localIPv4Addresses()) add(address);
	add("10.0.2.2");
	const networks = await runCommand(
		[
			tools.docker,
			"inspect",
			PROFILE,
			"--format",
			"{{range .NetworkSettings.Networks}}{{.Gateway}}\n{{end}}",
		],
		{ env: clusterEnv(), timeoutMs: 60_000 },
	);
	for (const line of networks.stdout.split("\n")) add(line.trim());
	const route = await minikube(["ssh", "--", "ip", "route", "show", "default"], 120_000);
	const match = /\bvia\s+(\d+\.\d+\.\d+\.\d+)\b/.exec(route.stdout);
	if (match !== null) add(match[1]);
	return candidates;
}

interface Beacon {
	readonly port: number;
	readonly token: string;
	close(): void;
}

/**
 * A one-shot TCP beacon on the wildcard address: every connection is answered
 * with a fresh random token, so a connection accepted by anything else cannot
 * be mistaken for reachability.
 */
async function startBeacon(): Promise<Beacon> {
	const token = crypto.randomUUID();
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
 * Throwaway-Pod dialer: it reports this Pod's own CIDR (the node's pod subnet)
 * and, for every candidate, `ok` only when the beacon's token came back.
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

async function probeReachFromPod(
	candidates: readonly string[],
	beacon: Beacon,
): Promise<ReachProbe> {
	const output = await runToolPod(["bun", "-e", REACH_PROBE_SCRIPT], {
		image: BASE_IMAGE,
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
 * Restore Pod egress when the node's FORWARD policy is DROP (kicbase's
 * dockerd can leave it there, and every forwarded Pod packet then dies).
 * Idempotent: the rule is inserted only when `iptables -C` does not find it.
 */
async function repairNodeForwarding(subnet: string): Promise<string | null> {
	const policy = await minikube(["ssh", "--", "sudo", "iptables", "-S", "FORWARD"], 120_000);
	const hasRule = await minikube(
		["ssh", "--", "sudo", "iptables", "-C", "FORWARD", "-s", subnet, "-j", "ACCEPT"],
		120_000,
	);
	if (hasRule.code === 0) return null;
	if (policy.code !== 0 || !policy.stdout.includes("-P FORWARD DROP")) return null;
	log(`node drops forwarded Pod traffic (FORWARD policy DROP); allowing ${subnet}`);
	const repair = await minikube(
		["ssh", "--", "sudo", "iptables", "-I", "FORWARD", "1", "-s", subnet, "-j", "ACCEPT"],
		120_000,
	);
	if (repair.code !== 0) {
		log(`WARN node pod-egress repair failed: ${repair.stderr.slice(-300)}`);
		return null;
	}
	return `after allowing ${subnet} through the node's FORWARD chain`;
}

/** Measure the address a Pod can dial; never infer it. */
async function resolveReachableAddress(): Promise<ReachProbe> {
	const candidates = await podReachableCandidates();
	const beacon = await startBeacon();
	try {
		const direct = await probeReachFromPod(candidates, beacon);
		if (direct.address !== "") return direct;
		if (direct.podCidr !== "") {
			const repaired = await repairNodeForwarding(direct.podCidr);
			if (repaired !== null) {
				const after = await probeReachFromPod(candidates, beacon);
				after.detail = `${after.detail} (${repaired})`;
				return after;
			}
		}
		return direct;
	} finally {
		beacon.close();
	}
}

// ---------------------------------------------------------------------------
// Throwaway Pods
// ---------------------------------------------------------------------------

/**
 * Run one bounded command in a throwaway Pod with the same hardened shape the
 * provider uses, and remove it no matter the outcome.
 */
async function runToolPod(
	command: string[],
	opts: { image?: string; env?: Record<string, string> } = {},
): Promise<string> {
	mkdirSync(paths.manifests, { recursive: true });
	const name = `omp-dev-tool-${crypto.randomUUID().slice(0, 8)}`;
	const manifestPath = join(paths.manifests, `${name}.json`);
	writeFileSync(
		manifestPath,
		JSON.stringify({
			apiVersion: "v1",
			kind: "Pod",
			metadata: { name, namespace: NAMESPACE, labels: { [MANIFEST_LABEL]: "true" } },
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
						image: opts.image ?? BASE_IMAGE,
						command,
						env: Object.entries(opts.env ?? {}).map(([key, value]) => ({ name: key, value })),
						securityContext: {
							allowPrivilegeEscalation: false,
							readOnlyRootFilesystem: true,
							capabilities: { drop: ["ALL"] },
						},
					},
				],
			},
		}),
	);
	const create = await kube(["create", "-f", manifestPath]);
	if (create.code !== 0) {
		removeManifest(manifestPath);
		die(`creating probe Pod ${name} failed: ${create.stderr.slice(-300)}`);
	}
	let output: string | null = null;
	let failure: string | null = null;
	try {
		const phase = await waitFor(
			`probe Pod ${name} to finish`,
			async () => {
				const pod = await kubeJson([
					"get",
					"pod",
					name,
					"-n",
					NAMESPACE,
					"--ignore-not-found",
					"-o",
					"json",
				]);
				const state = textOf(nested(pod, "status", "phase"));
				return state === "Succeeded" || state === "Failed" ? state : null;
			},
			{ timeoutMs: PROBE_TIMEOUT_MS, intervalMs: 1_500 },
		);
		const logs = await kube(["logs", name, "-n", NAMESPACE], 60_000);
		if (phase === "Succeeded") output = logs.stdout;
		else failure = `probe Pod ${name} ended ${phase}: ${logs.stdout.slice(-400)}`;
	} catch (error) {
		failure = `probe Pod ${name} failed: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		// `die` exits the process, so the removal must happen here, not in a
		// caller: a failed probe may not leak its Pod.
		await kube(
			["delete", "pod", name, "-n", NAMESPACE, "--ignore-not-found", "--wait=false"],
			60_000,
		);
		removeManifest(manifestPath);
	}
	if (failure !== null) die(failure);
	return output ?? "";
}

function removeManifest(manifestPath: string): void {
	try {
		rmSync(manifestPath, { force: true });
	} catch {
		// Best effort: a leftover manifest is a clue, not a resource.
	}
}

// ---------------------------------------------------------------------------
// TLS + derived image context
// ---------------------------------------------------------------------------

/**
 * Whether the gateway certificate covers `address` and stays valid beyond the
 * renewal window. SAN text alone would happily reuse the 30-day certificate
 * after it expired.
 */
async function certificateCovers(address: string): Promise<boolean> {
	const certPath = join(paths.tls, "server.crt");
	const keyPath = join(paths.tls, "server.key");
	if (!existsSync(certPath) || !existsSync(keyPath)) return false;
	const san = await runCommand(
		[tools.openssl, "x509", "-in", certPath, "-noout", "-ext", "subjectAltName"],
		{ timeoutMs: 60_000 },
	);
	if (san.code !== 0 || !san.stdout.includes(`IP Address:${address}`)) return false;
	const valid = await runCommand(
		[tools.openssl, "x509", "-in", certPath, "-noout", "-checkend", String(CERT_RENEWAL_WINDOW_S)],
		{ timeoutMs: 60_000 },
	);
	return valid.code === 0;
}

/**
 * The throwaway CA + server certificate. The Pod-reachable address is a SAN:
 * the clone Pod VERIFIES the certificate (the derived image trusts the CA), so
 * a certificate that does not cover the dialed address is a hard failure.
 */
async function ensureCertificates(address: string): Promise<void> {
	if (await certificateCovers(address)) {
		log(`gateway certificate covers ${address} and is not near expiry`);
		return;
	}
	if (CHECK_ONLY) die(`TLS material is missing, near expiry, or does not cover ${address}`);
	log(`generating a throwaway CA + gateway certificate for ${address}`);
	mkdirSync(paths.tls, { recursive: true });
	const caKey = join(paths.tls, "ca.key");
	const caCert = join(paths.tls, "ca.crt");
	const serverKey = join(paths.tls, "server.key");
	const serverCsr = join(paths.tls, "server.csr");
	const serverCert = join(paths.tls, "server.crt");
	const extFile = join(paths.tls, "san.cnf");
	writeFileSync(extFile, `subjectAltName = IP:${address}, IP:127.0.0.1, DNS:localhost\n`);

	const ca = await runCommand(
		[
			tools.openssl,
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
			"30",
			"-subj",
			"/CN=omp-web dev CA",
		],
		{ timeoutMs: 120_000 },
	);
	if (ca.code !== 0) die(`CA generation failed: ${ca.stderr.slice(-300)}`);
	const csr = await runCommand(
		[
			tools.openssl,
			"req",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			serverKey,
			"-out",
			serverCsr,
			"-subj",
			`/CN=${address}`,
		],
		{ timeoutMs: 120_000 },
	);
	if (csr.code !== 0) die(`gateway CSR generation failed: ${csr.stderr.slice(-300)}`);
	const sign = await runCommand(
		[
			tools.openssl,
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
			"30",
			"-sha256",
			"-extfile",
			extFile,
		],
		{ timeoutMs: 120_000 },
	);
	if (sign.code !== 0) die(`gateway certificate signing failed: ${sign.stderr.slice(-300)}`);

	// The derived image context: the base image + this CA, back as 10001.
	mkdirSync(paths.derivedContext, { recursive: true });
	writeFileSync(join(paths.derivedContext, "dev-ca.crt"), readFileSync(caCert));
	writeFileSync(
		join(paths.derivedContext, "Dockerfile"),
		[
			`FROM ${BASE_IMAGE}`,
			"USER root",
			"COPY dev-ca.crt /usr/local/share/ca-certificates/omp-dev-ca.crt",
			// The runtime image narrows PATH to /usr/local/bin:/usr/bin:/bin, so
			// the account tool below /usr/sbin needs an absolute path.
			"RUN /usr/sbin/update-ca-certificates",
			`USER ${RUNTIME_UID}:${RUNTIME_UID}`,
			"",
		].join("\n"),
	);
}

// ---------------------------------------------------------------------------
// Seed Git project + bare remote
// ---------------------------------------------------------------------------

interface SeedFacts {
	gitUrl: string;
	branch: string;
	commit: string;
}

/**
 * Two commits on `main` in the work repo (the registered seed project), a bare
 * `seed.git` beside it, and an `origin` pointing at the `git://` URL Pods will
 * fetch: a kubernetes clone requires a remote the Pod can reach. Idempotent:
 * an existing repo keeps its history; only the remote URL and the bare mirror
 * are reconciled.
 */
async function ensureSeedRepo(address: string): Promise<SeedFacts> {
	if (!CHECK_ONLY) {
		mkdirSync(paths.seedProject, { recursive: true });
		mkdirSync(paths.gitRoot, { recursive: true });
	}
	const bare = join(paths.gitRoot, "seed.git");
	const gitUrl = `git://${address}:${GIT_PORT}/seed.git`;
	const branch = "main";
	// Fixture commits carry the operator's real Git identity from the existing
	// gitconfig; a missing identity must fail the run, never be invented here.
	const git = (args: readonly string[]) =>
		runCommand([tools.git, ...args], { env: clusterEnv(), timeoutMs: 120_000 });

	if (!existsSync(join(paths.seedProject, ".git"))) {
		if (CHECK_ONLY) die(`seed project ${paths.seedProject} is missing`);
		for (const key of ["user.name", "user.email"]) {
			const configured = await git(["config", "--get", key]);
			if (configured.code !== 0 || configured.stdout.trim() === "") {
				die(`Git ${key} is not configured; set it before creating dev fixture commits`);
			}
		}
		log(`creating the seed project at ${paths.seedProject}`);
		writeFileSync(
			join(paths.seedProject, "README.md"),
			"# omp-web dev seed\n\nThe seed project for the Kubernetes dev environment.\n",
		);
		let step = await git(["init", "-b", branch, paths.seedProject]);
		if (step.code !== 0) die(`git init failed: ${step.stderr.slice(-300)}`);
		step = await git(["-C", paths.seedProject, "add", "-A"]);
		if (step.code !== 0) die(`git add failed: ${step.stderr.slice(-300)}`);
		step = await git(["-C", paths.seedProject, "commit", "-m", "seed: initial commit"]);
		if (step.code !== 0) die(`git commit failed: ${step.stderr.slice(-300)}`);
		writeFileSync(
			join(paths.seedProject, "NOTES.md"),
			"Second commit, so the clone source has real history.\n",
		);
		step = await git(["-C", paths.seedProject, "add", "-A"]);
		if (step.code !== 0) die(`git add failed: ${step.stderr.slice(-300)}`);
		step = await git(["-C", paths.seedProject, "commit", "-m", "seed: second commit"]);
		if (step.code !== 0) die(`git commit failed: ${step.stderr.slice(-300)}`);
	}

	// `origin` tracks the advertised git:// URL (it moves only if the measured
	// reach address does); the bare mirror is populated over the LOCAL path so
	// it needs no daemon.
	const hasOrigin = await git(["-C", paths.seedProject, "remote", "get-url", "origin"]);
	if (hasOrigin.code === 0) {
		if (hasOrigin.stdout.trim() !== gitUrl) {
			if (CHECK_ONLY) {
				die(
					`seed project origin is "${hasOrigin.stdout.trim()}", expected ${gitUrl}; re-run without --check`,
				);
			}
			const setUrl = await git(["-C", paths.seedProject, "remote", "set-url", "origin", gitUrl]);
			if (setUrl.code !== 0) die(`git remote set-url failed: ${setUrl.stderr.slice(-300)}`);
		}
	} else {
		if (CHECK_ONLY) die(`seed project ${paths.seedProject} has no origin remote`);
		const addRemote = await git(["-C", paths.seedProject, "remote", "add", "origin", gitUrl]);
		if (addRemote.code !== 0) die(`git remote add failed: ${addRemote.stderr.slice(-300)}`);
	}

	if (!existsSync(bare)) {
		if (CHECK_ONLY) die(`bare seed repo ${bare} is missing`);
		const initBare = await git(["init", "--bare", `--initial-branch=${branch}`, bare]);
		if (initBare.code !== 0) die(`git init --bare failed: ${initBare.stderr.slice(-300)}`);
	}

	const head = await git(["-C", paths.seedProject, "rev-parse", "HEAD"]);
	const commit = head.stdout.trim();
	if (!/^[0-9a-f]{40}$/.test(commit)) die(`seed commit does not resolve: ${commit}`);

	if (CHECK_ONLY) {
		const bareHead = await git(["-C", bare, "rev-parse", `refs/heads/${branch}`]);
		if (bareHead.code !== 0 || bareHead.stdout.trim() !== commit) {
			die(`bare seed repo ${bare} is missing or stale; re-run without --check to republish`);
		}
	} else {
		const push = await git(["-C", paths.seedProject, "push", bare, `${branch}:${branch}`]);
		if (push.code !== 0) die(`pushing the seed to ${bare} failed: ${push.stderr.slice(-300)}`);
		const setHead = await git(["-C", bare, "symbolic-ref", "HEAD", `refs/heads/${branch}`]);
		if (setHead.code !== 0) die(`setting the bare HEAD failed: ${setHead.stderr.slice(-300)}`);
	}

	// Host-side proof that the advertised URL is not just a string: it works
	// only once `git daemon` runs, so a failure here is only reported.
	const hostProbe = await runCommand([tools.git, "ls-remote", gitUrl, branch], {
		env: clusterEnv(),
		timeoutMs: 30_000,
	});
	if (hostProbe.stdout.includes(commit)) log(`git daemon answers ${gitUrl}`);
	else log(`git daemon is not serving ${gitUrl} yet (start the git-daemon process)`);

	return { gitUrl, branch, commit };
}

// ---------------------------------------------------------------------------
// Fleet config, gateway source, env file
// ---------------------------------------------------------------------------

/**
 * The bwrap sandbox launches `OMP_RUNTIME_BIN` as argv[0] with the runtime
 * package root bound read-only, and its denylist refuses to bind anything
 * inside the operator home — which is where this script's own bun lives. A
 * copy in the dev root is therefore the sandbox's runtime.
 */
async function ensureSandboxRuntime(): Promise<void> {
	const sourceStats = statSync(tools.bun);
	const target = existsSync(paths.runtimeBin) ? statSync(paths.runtimeBin) : null;
	if (
		target !== null &&
		target.size === sourceStats.size &&
		target.mtimeMs >= sourceStats.mtimeMs
	) {
		log(`sandbox runtime ${paths.runtimeBin} is current`);
		return;
	}
	if (CHECK_ONLY) die(`sandbox runtime ${paths.runtimeBin} is missing or stale`);
	log(
		`copying the runtime binary to ${paths.runtimeBin} (the sandbox denylist forbids the operator home)`,
	);
	await Bun.write(paths.runtimeBin, Bun.file(tools.bun));
	chmodSync(paths.runtimeBin, 0o755);
}

function installConfig(namespace: string, context: string, storageClass: string): void {
	const config = {
		workspaceDir: paths.workspaces,
		providerProfiles: {
			bwrap: {
				id: "bwrap",
				provider: "bwrap",
				executable: join(REPO_ROOT, "dist-bundle", "providers", "bwrap-provider.js"),
				// The sandbox executes the runtime binary as argv[0]; the dev-root
				// copy keeps it out of the operator home, which the denylist refuses.
				tools: [paths.runtimeBin],
				network: "host",
			},
			kubernetes: {
				id: "kubernetes",
				provider: "kubernetes",
				executable: join(REPO_ROOT, "dist-bundle", "providers", "kubernetes-provider.js"),
				tools: [],
				context,
				namespace,
				image: CA_IMAGE,
				resources: { cpu: PROFILE_CPU, memory: PROFILE_MEMORY },
				storage: { class: storageClass, size: PROFILE_STORAGE_SIZE },
			},
		},
	};
	installFile(paths.config, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * The dev callback gateway: a streaming HTTPS proxy in front of the fleet's
 * callback routes, bound to the wildcard so a Pod can reach the measured
 * address. Only the three documented method/path pairs are forwarded; the
 * halves are long-lived and quiet apart from a heartbeat, so the idle timeout
 * is disabled.
 */
function installGateway(): void {
	const source = `#!/usr/bin/env bun
/**
 * Dev callback gateway (generated by scripts/dev-kubernetes.ts).
 *
 * Streaming HTTPS proxy in front of the fleet's callback routes. The allowlist
 * is frozen to POST /callback/up, GET /callback/down, and
 * POST /callback/bulk/<id> ([A-Za-z0-9_-]+); everything else is rejected here.
 */
import { readFileSync } from "node:fs";

const port = Number(process.env.OMP_DEV_PROXY_PORT);
const fleetPort = Number(process.env.OMP_DEV_FLEET_PORT);
const certPath = process.env.OMP_DEV_TLS_CERT ?? "";
const keyPath = process.env.OMP_DEV_TLS_KEY ?? "";
const REJECTED_BODY = ${JSON.stringify(GATEWAY_REJECTED_BODY)};
const UP_PATH = "/callback/up";
const DOWN_PATH = "/callback/down";
const BULK_PREFIX = "/callback/bulk/";

if (!Number.isInteger(port) || port <= 0) throw new Error("OMP_DEV_PROXY_PORT is not a port");
if (!Number.isInteger(fleetPort) || fleetPort <= 0) throw new Error("OMP_DEV_FLEET_PORT is not a port");

const server = Bun.serve({
	hostname: ${JSON.stringify(BIND_ADDRESS)},
	port,
	// Both callback halves are long-lived streams whose only traffic is the
	// transport heartbeat; the default idle timeout would close the quiet half.
	idleTimeout: 0,
	tls: { cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") },
	async fetch(req) {
		const url = new URL(req.url);
		const path = url.pathname;
		const bulkId = path.startsWith(BULK_PREFIX) ? path.slice(BULK_PREFIX.length) : "";
		const allowedBulk = bulkId !== "" && /^[A-Za-z0-9_-]+$/.test(bulkId);
		// No allowlisted pair carries a query string, so a request with one is
		// never forwarded.
		const allowed =
			url.search === "" &&
			((req.method === "POST" && path === UP_PATH) ||
				(req.method === "GET" && path === DOWN_PATH) ||
				(req.method === "POST" && allowedBulk));
		if (!allowed) {
			console.log("gateway reject " + req.method + " " + path + url.search);
			return new Response(REJECTED_BODY, { status: 404 });
		}
		const headers = new Headers(req.headers);
		headers.delete("host");
		headers.delete("content-length");
		try {
			const upstream = await fetch("http://127.0.0.1:" + fleetPort + path, {
				method: req.method,
				headers,
				body: req.method === "POST" ? (req.body ?? undefined) : undefined,
			});
			return new Response(upstream.body, {
				status: upstream.status,
				headers: upstream.headers,
			});
		} catch (error) {
			console.log("gateway upstream error " + req.method + " " + path + ": " + String(error));
			return new Response("callback upstream unreachable", { status: 502 });
		}
	},
});

console.log("omp-dev gateway listening on ${BIND_ADDRESS}:" + server.port + " -> 127.0.0.1:" + fleetPort);
`;
	installFile(paths.gateway, source);
}

/** A convenience stop script for the four long-lived dev processes. */
function installStopScript(): void {
	const source = `#!/bin/sh
# Stops the omp-web Kubernetes dev processes (generated by
# scripts/dev-kubernetes.ts). Pair it with \`stop.sh --cluster\` to also
# remove the minikube profile and its volume.
set -u
kill_match() {
  pattern="$1"
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -z "$pids" ]; then
    echo "not running: $pattern"
    return
  fi
  echo "stopping $pattern ($pids)"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
}
kill_match ${shellQuote(join(paths.root, "gateway.ts"))}
kill_match ${shellQuote(`fleet/cli.ts serve --port ${FLEET_PORT}`)}
kill_match ${shellQuote(`vite --port ${UI_PORT}`)}
kill_match ${shellQuote(`git daemon --base-path=${paths.gitRoot}`)}
if [ "\${1:-}" = "--cluster" ]; then
  echo "deleting minikube profile ${PROFILE}"
  MINIKUBE_HOME=${shellQuote(paths.minikubeHome)} KUBECONFIG=${shellQuote(paths.kubeconfig)} \\
    DOCKER_HOST=${shellQuote(tools.dockerHost)} ${shellQuote(tools.minikube)} delete -p ${PROFILE} || true
  DOCKER_HOST=${shellQuote(tools.dockerHost)} ${shellQuote(tools.docker)} rm -f ${PROFILE} || true
  DOCKER_HOST=${shellQuote(tools.dockerHost)} ${shellQuote(tools.docker)} volume rm ${PROFILE} || true
fi
`;
	installFile(paths.stop, source, 0o755);
}

interface DevFacts {
	namespace: string;
	context: string;
	storageClass: string;
	reachAddress: string;
	gitUrl: string;
	gitBranch: string;
	seedCommit: string;
	reachDetail: string;
}

/** The environment the FLEET process must run under. */
function fleetEnv(facts: DevFacts): Record<string, string> {
	return {
		OMP_FLEET_CONFIG: paths.config,
		OMP_FLEET_STATE: paths.state,
		OMP_FLEET_WORKSPACE_DIR: paths.workspaces,
		OMP_FLEET_CALLBACK_URL: `https://${facts.reachAddress}:${PROXY_PORT}`,
		OMP_FLEET_PORT: String(FLEET_PORT),
		OMP_KUBE_BIN: paths.kubeBin,
		OMP_KUBE_CONTEXT: facts.context,
		KUBECONFIG: paths.kubeconfig,
		MINIKUBE_HOME: paths.minikubeHome,
		DOCKER_HOST: tools.dockerHost,
		OMP_BWRAP_BIN: resolveTool("bwrap") ?? "bwrap",
		OMP_RUNTIME_BIN: paths.runtimeBin,
		OMP_RUNTIME_ENTRY: join(REPO_ROOT, "server", "index.ts"),
	};
}

function gatewayEnv(): Record<string, string> {
	return {
		OMP_DEV_PROXY_PORT: String(PROXY_PORT),
		OMP_DEV_FLEET_PORT: String(FLEET_PORT),
		OMP_DEV_TLS_CERT: join(paths.tls, "server.crt"),
		OMP_DEV_TLS_KEY: join(paths.tls, "server.key"),
	};
}

/** The probe's human-readable reach detail is an observation, not config. */
function withoutReachDetail(payload: object): Record<string, unknown> {
	const rest = { ...(payload as Record<string, unknown>) };
	delete rest.reachDetail;
	return rest;
}

function installEnvFile(facts: DevFacts, env: Record<string, string>): void {
	const payload = {
		generatedBy: "scripts/dev-kubernetes.ts",
		repoRoot: REPO_ROOT,
		devRoot: paths.root,
		profile: PROFILE,
		namespace: facts.namespace,
		context: facts.context,
		storageClass: facts.storageClass,
		reachAddress: facts.reachAddress,
		reachDetail: facts.reachDetail,
		proxyPort: PROXY_PORT,
		callbackUrl: `https://${facts.reachAddress}:${PROXY_PORT}`,
		fleetPort: FLEET_PORT,
		uiPort: UI_PORT,
		gitPort: GIT_PORT,
		gitUrl: facts.gitUrl,
		gitBranch: facts.gitBranch,
		seedCommit: facts.seedCommit,
		seedProject: paths.seedProject,
		baseImage: BASE_IMAGE,
		derivedImage: CA_IMAGE,
		kubeBin: paths.kubeBin,
		kubeconfig: paths.kubeconfig,
		minikubeHome: paths.minikubeHome,
		dockerHost: tools.dockerHost,
		configPath: paths.config,
		statePath: paths.state,
		workspaceDir: paths.workspaces,
		gatewaySource: paths.gateway,
		stopScript: paths.stop,
		fleetEnv: env,
		gatewayEnv: gatewayEnv(),
	};
	if (CHECK_ONLY) {
		let stored: string | null = null;
		try {
			const existing = asRecord(JSON.parse(readFileSync(paths.env, "utf8")));
			stored = existing === null ? null : JSON.stringify(withoutReachDetail(existing), null, 2);
		} catch {
			stored = null;
		}
		if (stored === null || stored !== JSON.stringify(withoutReachDetail(payload), null, 2)) {
			die(`${paths.env} is missing or stale; re-run without --check to reconcile`);
		}
		return;
	}
	writeFileSync(paths.env, `${JSON.stringify(payload, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Gateway probe (throwaway Pod)
// ---------------------------------------------------------------------------

const GATEWAY_PROBE_SCRIPT = `
const base = process.env.OMP_GATEWAY_URL;
const rejected = process.env.OMP_GATEWAY_REJECT ?? "rejected";
const probe = async (method, path) => {
  try {
    const response = await fetch(base + path, { method });
    const text = await response.text();
    console.log(method + " " + path + " -> " + response.status + " " + (text === rejected ? "REJECTED" : "FORWARDED"));
  } catch (error) {
    console.log(method + " " + path + " -> ERROR " + String(error && error.message ? error.message : error));
  }
};
await probe("GET", "/callback/up");
await probe("POST", "/callback/up");
await probe("POST", "/callback/other");
`;

/** Prove the derived image's CA trust + the gateway allowlist from a Pod. */
async function probeGatewayFromPod(address: string): Promise<void> {
	log(`probing the gateway from a Pod at https://${address}:${PROXY_PORT}`);
	const output = await runToolPod(["bun", "-e", GATEWAY_PROBE_SCRIPT], {
		image: CA_IMAGE,
		env: {
			OMP_GATEWAY_URL: `https://${address}:${PROXY_PORT}`,
			OMP_GATEWAY_REJECT: GATEWAY_REJECTED_BODY,
		},
	});
	const lines = output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	for (const line of lines) log(`pod probe ${line}`);
	const getUp = lines.find((line) => line.startsWith("GET /callback/up ->")) ?? "";
	const postUp = lines.find((line) => line.startsWith("POST /callback/up ->")) ?? "";
	const postOther = lines.find((line) => line.startsWith("POST /callback/other ->")) ?? "";
	const ok =
		getUp.includes("REJECTED") && postUp.includes("FORWARDED") && postOther.includes("REJECTED");
	if (!ok) die(`gateway probe failed: ${lines.join("; ")}`);
	log("gateway probe ok: Pod trusts the CA, allowlisted pair forwards, others reject");
}

// ---------------------------------------------------------------------------
// Port observation (read-only)
// ---------------------------------------------------------------------------

function portAnswers(port: number): Promise<boolean> {
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const client = connect({ host: "127.0.0.1", port });
	const deadline = setTimeout(() => {
		client.destroy();
		resolve(false);
	}, PORT_PROBE_TIMEOUT_MS);
	client.on("connect", () => {
		clearTimeout(deadline);
		client.destroy();
		resolve(true);
	});
	client.on("error", () => {
		clearTimeout(deadline);
		resolve(false);
	});
	return promise;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function printReport(
	facts: DevFacts,
	options: { proxyUp: boolean; fleetUp: boolean; uiUp: boolean },
): void {
	const callbackUrl = `https://${facts.reachAddress}:${PROXY_PORT}`;
	console.log("");
	console.log("=== omp-web Kubernetes dev environment ===");
	console.log(`dev root        ${paths.root}`);
	console.log(
		`minikube        profile ${PROFILE} (context ${facts.context}), namespace ${facts.namespace}`,
	);
	console.log(`storage class   ${facts.storageClass}`);
	console.log(`reach address   ${facts.reachAddress} (${facts.reachDetail})`);
	console.log(
		`images          ${BASE_IMAGE} (base), ${CA_IMAGE} (derived, CA-trusting, uid ${RUNTIME_UID})`,
	);
	console.log(`kubectl wrapper ${paths.kubeBin}`);
	console.log(`callback URL    ${callbackUrl}`);
	console.log(
		`seed project    ${paths.seedProject} (${facts.gitUrl}, branch ${facts.gitBranch}, ${facts.seedCommit.slice(0, 12)})`,
	);
	console.log(`config / state  ${paths.config} / ${paths.state}`);
	console.log(`workspace dir   ${paths.workspaces}`);
	console.log(`facts           ${paths.env}`);
	console.log(`stop script     ${paths.stop}`);
	console.log(
		`services        gateway ${options.proxyUp ? "up" : "DOWN"} on :${PROXY_PORT}, fleet ${options.fleetUp ? "up" : "DOWN"} on :${FLEET_PORT}, ui ${options.uiUp ? "up" : "DOWN"} on :${UI_PORT}`,
	);
	console.log("");
	console.log("fleet environment (start the fleet with these):");
	for (const [key, value] of Object.entries(fleetEnv(facts))) {
		console.log(`  ${key}=${value}`);
	}
	console.log("");
	console.log("gateway environment:");
	for (const [key, value] of Object.entries(gatewayEnv())) {
		console.log(`  ${key}=${value}`);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	if (process.argv.includes("--help")) {
		console.log(
			[
				"usage: bun scripts/dev-kubernetes.ts [--check] [--probe-gateway] [--no-probe]",
				"",
				"  (default)         bring up / reconcile the cluster-side dev infrastructure",
				"  --check           verify existing infrastructure only; never writes",
				"  --probe-gateway   dial the running dev gateway from a throwaway Pod",
				"  --no-probe        skip the Pod-reachability probe",
				`  OMP_DEV_KUBE_ROOT overrides the dev root (default ${tmpdir()}/omp-dev-kube)`,
			].join("\n"),
		);
		return;
	}

	const startedAt = Date.now();
	if (!CHECK_ONLY) {
		mkdirSync(paths.root, { recursive: true });
		mkdirSync(paths.workspaces, { recursive: true });
	}
	resolveTools();
	tools.dockerHost = await resolveDockerEndpoint();
	log(`dev root ${paths.root}`);
	log(`docker endpoint ${tools.dockerHost}`);

	await ensureBundle();

	const context = await ensureCluster();
	const storageClass = await storageClassName();
	const baseImage = await ensureBaseImage();

	let reach: ReachProbe = { address: "", detail: "not probed", podCidr: "" };
	if (!NO_PROBE) {
		reach = await resolveReachableAddress();
	}
	if (reach.address === "") {
		// `--no-probe` trusts the last recorded measurement; every exported URL
		// and the certificate still need one, so a missing fact is fatal.
		let recorded = "";
		try {
			recorded = existsSync(paths.env)
				? textOf(nested(JSON.parse(readFileSync(paths.env, "utf8")), "reachAddress"))
				: "";
		} catch {
			recorded = "";
		}
		reach.address = recorded;
		reach.detail = recorded === "" ? "not probed and not recorded" : `recorded in ${paths.env}`;
	}
	if (reach.address === "") die(`no Pod-reachable address was resolved (${reach.detail})`);
	log(`Pod-reachable address ${reach.address}`);

	await ensureCertificates(reach.address);
	await ensureDerivedImage(baseImage);
	await ensureSandboxRuntime();
	const seed = await ensureSeedRepo(reach.address);

	installConfig(NAMESPACE, context, storageClass);
	installGateway();
	installStopScript();

	const facts: DevFacts = {
		namespace: NAMESPACE,
		context,
		storageClass,
		reachAddress: reach.address,
		gitUrl: seed.gitUrl,
		gitBranch: seed.branch,
		seedCommit: seed.commit,
		reachDetail: reach.detail,
	};
	installEnvFile(facts, fleetEnv(facts));

	if (PROBE_GATEWAY) {
		await probeGatewayFromPod(reach.address);
	}

	printReport(facts, {
		proxyUp: await portAnswers(PROXY_PORT),
		fleetUp: await portAnswers(FLEET_PORT),
		uiUp: await portAnswers(UI_PORT),
	});
	log(`ready in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

await main();
