#!/usr/bin/env bun
/**
 * test-bwrap-lifecycle — endpoint-to-endpoint acceptance walk of the
 * production fleet's bwrap lane against a REAL bwrap sandbox and REAL
 * omp-session daemons.
 *
 * Everything runs against production code paths: `startFleet` boots the real
 * control plane in-process, the profile executes the built
 * `dist-bundle/providers/bwrap-provider.js`, and the sandbox launches the real
 * session server. No fake provider, no fake daemon, no injected seams.
 *
 * Walk (one phase per line):
 *   prerequisite  resolve ONE absolute bwrap executable + the built provider /
 *                 runtime, mint a hermetic temp HOME/config/state/workspace
 *                 root and a seed Git project
 *   preflight     run the production `preflight --profile bwrap` command
 *   spawn         start the fleet, register the seed project, `add-clone`
 *                 with automatic start, prove the pair + sandbox came up
 *   stream        open a production virtual stream, name the session, ask for
 *                 its stats, and wait for durable transcript bytes
 *   wake          stop (retaining the volume + store), wake the SAME session,
 *                 and prove the durable bytes survived byte-identically
 *   delete        restart the fleet, prove reconnection, then run the verified
 *                 deletion gate and prove the volume is gone and the store is
 *                 frozen read-only
 *   cleanup       stop the fleet, restore the environment, remove the temp root
 *
 * Usage: bun scripts/test-bwrap-lifecycle.ts [--keep]
 * Exit 0 + `BWRAP_LIFECYCLE_ACCEPTANCE_OK` only after every assertion AND
 * every cleanup step succeeds. Any failure prints `BLOCKED <phase>` with
 * sanitized diagnostics and exits nonzero. SIGINT/SIGTERM/SIGHUP run the same
 * single cleanup owner before exiting.
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { DaemonTransportRegistry } from "../fleet/daemon-transport";
import { FleetLogStore } from "../fleet/log-store";
import { startFleet, type FleetServer } from "../fleet/server";
import type { CallbackEnvelope } from "../shared/callback-protocol";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = realpathSync(join(import.meta.dir, ".."));
const KEEP = process.argv.includes("--keep");
const MARKER = "BWRAP_LIFECYCLE_ACCEPTANCE_OK";
const PROVIDER_ID = "bwrap";
const CLONE_NAME = "clone-a";

const SUBPROCESS_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 120_000;
const PAIR_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 180_000;

type Phase = "prerequisite" | "preflight" | "spawn" | "stream" | "wake" | "delete" | "cleanup";

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
// Single cleanup owner (identical pattern in scripts/test-kubernetes-minikube.ts)
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
// Fleet HTTP helpers
// ---------------------------------------------------------------------------

let fleet: FleetServer | null = null;

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

interface SessionRow {
	daemonId: string;
	name?: string;
	status?: string;
	workspace?: { kind?: string; profileId?: string };
}

async function sessionRow(daemonId: string): Promise<SessionRow | null> {
	const res = await ctl("/ctl/sessions");
	if (res.status !== 200 || !Array.isArray(res.body)) return null;
	const rows = res.body as SessionRow[];
	return rows.find((row) => row.daemonId === daemonId) ?? null;
}

function transportOf(server: FleetServer): DaemonTransportRegistry {
	// `FleetServer` deliberately hides the transport; the acceptance walk needs
	// the same registry the browser edge drives.
	const impl = server as unknown as { transport: DaemonTransportRegistry };
	return impl.transport;
}

// ---------------------------------------------------------------------------
// Phase 1: prerequisite
// ---------------------------------------------------------------------------

const sandboxRoot = (() => {
	acceptance.cleanup.install();
	const root = redact(mkdtempSync(join(tmpdir(), "omp-bwrap-acceptance-")), "tmp-root");
	// Registered FIRST so the LIFO drain removes it LAST, after every other
	// resource has been released.
	acceptance.cleanup.add("remove temporary root", () => {
		if (!KEEP) rmSync(root, { recursive: true, force: true });
		else console.log(`sandbox kept at ${root}`);
	});
	return root;
})();

acceptance.cleanup.add("restore environment", () => restoreEnv());

const sandboxHome = join(sandboxRoot, "home");
const workspaceDir = join(sandboxRoot, "workspaces");
const statePath = join(sandboxRoot, "fleet-state.json");
const configPath = join(sandboxRoot, "config.json");
const logsDir = join(sandboxRoot, "logs");
const projectDir = join(sandboxRoot, "seed-project");
const gitConfigPath = join(sandboxHome, ".gitconfig");

let bwrapBin = "";
let bunBin = "";
let gitBin = "";
let providerExecutable = "";
let runtimeEntry = "";
let cliBundle = "";

async function phasePrerequisite(): Promise<void> {
	bwrapBin = redact(resolveTool("bwrap") ?? "", "bwrap");
	bunBin = redact(realpathSync(process.execPath), "bun");
	gitBin = resolveTool("git") ?? "";
	providerExecutable = join(REPO_ROOT, "dist-bundle", "providers", "bwrap-provider.js");
	runtimeEntry = join(REPO_ROOT, "server", "index.ts");
	cliBundle = join(REPO_ROOT, "dist-bundle", "cli.js");

	acceptance.require(
		"one absolute bwrap executable resolves",
		bwrapBin !== "" && bwrapBin.startsWith("/"),
		bwrapBin === "" ? "bwrap is not on PATH" : bwrapBin,
	);
	acceptance.require("git is available", gitBin !== "", "git is not on PATH");
	acceptance.require(
		"the built bwrap provider exists",
		existsSync(providerExecutable),
		`${providerExecutable} is missing; run \`bun run build\` first`,
	);
	acceptance.require(
		"the built CLI bundle exists",
		existsSync(cliBundle),
		`${cliBundle} is missing; run \`bun run build\` first`,
	);
	acceptance.require(
		"the runtime entry exists",
		existsSync(runtimeEntry),
		`${runtimeEntry} is missing`,
	);
	acceptance.require(
		"the bwrap sandbox admits unprivileged user namespaces",
		await bwrapUsernsOk(),
		"bwrap could not mount+exec; check kernel.unprivileged_userns_clone / AppArmor",
	);

	// Hermetic HOME/config/state/workspace root. Mutating process.env is what
	// makes the in-process fleet, the provider, the detached supervisor and the
	// sandboxed daemon all share one isolated root.
	mkdirSync(sandboxHome, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	writeFileSync(
		gitConfigPath,
		"[user]\n\tname = bwrap-acceptance\n\temail = bwrap@acceptance.test\n",
	);

	setEnv("HOME", sandboxHome);
	setEnv("XDG_CONFIG_HOME", join(sandboxRoot, "xdg-config"));
	setEnv("XDG_DATA_HOME", join(sandboxRoot, "xdg-data"));
	setEnv("XDG_STATE_HOME", join(sandboxRoot, "xdg-state"));
	setEnv("XDG_CACHE_HOME", join(sandboxRoot, "xdg-cache"));
	setEnv("TMPDIR", join(sandboxRoot, "tmp"));
	setEnv("GIT_CONFIG_GLOBAL", gitConfigPath);
	setEnv("GIT_CONFIG_SYSTEM", "/dev/null");
	setEnv("GIT_CONFIG_NOSYSTEM", "1");
	setEnv("OMP_BWRAP_BIN", bwrapBin);
	setEnv("OMP_RUNTIME_BIN", bunBin);
	setEnv("OMP_RUNTIME_ENTRY", runtimeEntry);
	setEnv("OMP_FLEET_CONFIG", configPath);
	setEnv("OMP_FLEET_STATE", statePath);
	setEnv("OMP_FLEET_WORKSPACE_DIR", workspaceDir);
	unsetEnv("OMP_FLEET_CALLBACK_URL");
	mkdirSync(join(sandboxRoot, "tmp"), { recursive: true });

	// The profile: the built provider, the sandbox's own bun pinned as a
	// read-only tool bind, and host networking so the sandbox reaches the
	// fleet's loopback callback URL.
	const config = {
		workspaceDir,
		providerProfiles: {
			[PROVIDER_ID]: {
				id: PROVIDER_ID,
				provider: "bwrap",
				executable: providerExecutable,
				tools: [dirname(bunBin)],
				network: "host",
			},
		},
	};
	writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

	// Seed Git project: the clone's local source for `--local`-style creates.
	const seedFile = join(projectDir, "README.md");
	if (!existsSync(seedFile)) writeFileSync(seedFile, "bwrap acceptance seed\n");
	const init = await runCommand([gitBin, "init", "-b", "main", projectDir]);
	acceptance.require("seed project git init", init.code === 0, init.stderr.slice(-300));
	const add = await runCommand([gitBin, "-C", projectDir, "add", "-A"]);
	acceptance.require("seed project git add", add.code === 0, add.stderr.slice(-300));
	const commit = await runCommand([gitBin, "-C", projectDir, "commit", "-m", "seed"]);
	acceptance.require("seed project git commit", commit.code === 0, commit.stderr.slice(-300));

	acceptance.settle();
}

async function bwrapUsernsOk(): Promise<boolean> {
	const probe = await runCommand(
		[bwrapBin, "--ro-bind", "/", "/", "--", "echo", "bwrap-userns-ok"],
		{ timeoutMs: 30_000 },
	);
	return probe.code === 0 && probe.stdout.includes("bwrap-userns-ok");
}

// ---------------------------------------------------------------------------
// Phase 2: preflight
// ---------------------------------------------------------------------------

async function phasePreflight(): Promise<void> {
	const result = await runCommand([bunBin, cliBundle, "preflight", "--profile", PROVIDER_ID], {
		timeoutMs: 180_000,
	});
	acceptance.check(
		"preflight --profile bwrap succeeds",
		result.code === 0,
		`exit ${result.code}: ${result.stderr.slice(-400) || result.stdout.slice(-400)}`,
	);
	acceptance.check(
		"preflight reports no failing rows",
		!result.stdout.includes("[FAIL]"),
		result.stdout
			.split("\n")
			.filter((line) => line.includes("[FAIL]"))
			.join(" "),
	);
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Phase 3: spawn
// ---------------------------------------------------------------------------

let daemonId = "";
/**
 * Loopback port of the running fleet. The sandbox daemon dials the callback
 * URL captured at spawn, so the delete-phase restart MUST rebind the same
 * port: a fresh ephemeral port would leave the live sandbox dialing a dead
 * address and reconnection could never succeed.
 */
let fleetPort = 0;

async function startFleetInstance(): Promise<void> {
	fleet = await startFleet({
		port: fleetPort,
		statePath,
		configPath,
		workspaceDir,
		statsConfig: {
			statsDbPath: join(sandboxRoot, "stats.db"),
			sessionsDir: join(sandboxRoot, "agent-sessions"),
		},
	});
	fleetPort = fleet.port;
}

async function phaseSpawn(): Promise<void> {
	acceptance.cleanup.add("close fleet", async () => {
		const running = fleet;
		fleet = null;
		await running?.close();
	});

	await startFleetInstance();
	acceptance.require("fleet boots on an ephemeral loopback port", fleet !== null && fleet.port > 0);

	const project = await ctl("/ctl/projects", { method: "POST", body: { path: projectDir } });
	const projectBody = project.body as { project?: { projectId?: string } } | null;
	const projectId = projectBody?.project?.projectId ?? "";
	acceptance.require(
		"seed project registered",
		project.status === 201 && projectId !== "",
		`status ${project.status}: ${JSON.stringify(project.body)}`,
	);

	const clone = await ctl("/ctl/clones", {
		method: "POST",
		body: { projectId, name: CLONE_NAME, profileId: PROVIDER_ID, start: true },
	});
	const cloneBody = clone.body as { entry?: { daemonId?: string } } | null;
	daemonId = cloneBody?.entry?.daemonId ?? "";
	acceptance.require(
		"add-clone starts clone-a automatically",
		clone.status === 201 && daemonId !== "",
		`status ${clone.status}: ${JSON.stringify(clone.body)}`,
	);

	const ready = await waitFor(
		`clone ${daemonId} to reach ready`,
		async () => {
			const row = await sessionRow(daemonId);
			return row?.status === "ready" ? row : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS },
	);
	acceptance.check("clone-a reaches ready", ready.status === "ready", ready.status ?? "");
	acceptance.check(
		"clone-a is a bwrap clone workspace",
		ready.workspace?.kind === "clone" && ready.workspace?.profileId === PROVIDER_ID,
		JSON.stringify(ready.workspace),
	);

	const transport = acceptance.expect(
		fleet === null ? null : transportOf(fleet),
		"fleet exposes the callback transport",
	);
	const paired = await waitFor(
		"the callback pair",
		() => (transport.pairStatus(daemonId).paired ? true : null),
		{ timeoutMs: PAIR_TIMEOUT_MS },
	);
	acceptance.check("callback pair established", paired === true);

	const pidfile = readPidfile();
	acceptance.check(
		"sandbox pidfile recorded",
		pidfile !== null && pidfile.pid > 0,
		JSON.stringify(pidfile),
	);
	acceptance.settle();
}

interface Pidfile {
	pid: number;
	procStartTime?: number;
}

function readPidfile(): Pidfile | null {
	const path = join(workspaceDir, ".provider-state", daemonId, "provider.pid.json");
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
		return typeof raw.pid === "number" ? { pid: raw.pid } : null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Phase 4: stream
// ---------------------------------------------------------------------------

interface StreamHandle {
	streamId: string;
	frames: CallbackEnvelope[];
	drained: () => void;
}

async function openVirtualStream(): Promise<StreamHandle> {
	if (fleet === null) throw new Error("fleet is not running");
	const transport = transportOf(fleet);
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

async function sendCall(stream: StreamHandle, id: string, method: string, args: unknown[]) {
	if (fleet === null) throw new Error("fleet is not running");
	await transportOf(fleet).sendToDaemon(daemonId, {
		streamId: stream.streamId,
		kind: "command",
		payload: { type: "call", id, method, args },
	});
}

function callAnswerOk(answer: unknown): boolean {
	const payload = answer as { ok?: unknown } | null;
	return payload?.ok === true;
}

function callResult(stream: StreamHandle, id: string): unknown {
	for (const envelope of stream.frames) {
		const payload = envelope.payload as { type?: string; id?: string; ok?: boolean } | null;
		if (payload?.type === "call_result" && payload.id === id) return payload;
	}
	return null;
}

/** Durable store view of the workspace's transcript bytes. */
function storedLineage() {
	const store = FleetLogStore.load(logsDir);
	const sessions = store.listStoredSessions(daemonId);
	const withMain = sessions.filter(
		(session) => session.bytes > 0 && session.mainRelpath !== undefined,
	);
	return { store, sessions: withMain };
}

async function phaseStream(): Promise<void> {
	const stream = await openVirtualStream();
	acceptance.cleanup.add("detach virtual stream", () => stream.drained());

	await sendCall(stream, "name-1", "setSessionName", ["bwrap-acceptance"]);
	const named = await waitFor("the setSessionName answer", () => callResult(stream, "name-1"), {
		timeoutMs: POLL_TIMEOUT_MS,
	});
	acceptance.check(
		"session named through the virtual stream",
		callAnswerOk(named),
		JSON.stringify(named),
	);

	await sendCall(stream, "stats-1", "getSessionStats", []);
	const stats = await waitFor("the getSessionStats answer", () => callResult(stream, "stats-1"), {
		timeoutMs: POLL_TIMEOUT_MS,
	});
	acceptance.check("getSessionStats answered", callAnswerOk(stats), JSON.stringify(stats));

	// The SDK persists a session file lazily (`SessionManager.#shouldHaveSessionFile`
	// requires a forced creation, an on-disk current file, or the first assistant
	// entry), so a model-less boot that is only named and statted owns no
	// `<sessions>/<project>/<id>.jsonl` for the tailer to discover and stream.
	// `fork` is a production wire method that writes the current session (title
	// slot + header, carrying the name set above) to a new file with no model
	// turn: the reachable daemon -> tailer -> fleet-store observable.
	await sendCall(stream, "fork-1", "fork", []);
	const forked = await waitFor("the fork answer", () => callResult(stream, "fork-1"), {
		timeoutMs: POLL_TIMEOUT_MS,
	});
	acceptance.check(
		"session transcript written through the virtual stream",
		callAnswerOk(forked),
		JSON.stringify(forked),
	);

	const stored = await waitFor(
		"stored transcript bytes",
		() => {
			const { sessions } = storedLineage();
			return sessions[0] ?? null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 500 },
	);
	acceptance.check(
		"durable transcript bytes stored",
		stored.bytes > 0 && stored.mainRelpath !== undefined,
		JSON.stringify({ sessionId: stored.sessionId, bytes: stored.bytes }),
	);
	// The stored bytes must be the daemon's real transcript, not an unrelated
	// artifact: the fork carries the name set through this same virtual stream.
	const store = storedLineage().store;
	const mainRelpath = stored.mainRelpath;
	const transcript =
		mainRelpath === undefined ? null : store.readStored(daemonId, stored.sessionId, mainRelpath);
	acceptance.check(
		"stored transcript carries the stream-set session name",
		transcript !== null && transcript.includes(Buffer.from("bwrap-acceptance")),
		`${mainRelpath ?? "(no main)"}: ${transcript === null ? "unreadable" : `${transcript.length} bytes`}`,
	);
	stream.drained();
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Phase 5: wake
// ---------------------------------------------------------------------------

interface Snapshot {
	sessionId: string;
	mainRelpath: string;
	bytes: Buffer;
	pid: number;
}

function captureSnapshot(): Snapshot {
	const { store, sessions } = storedLineage();
	const newest = sessions[0];
	if (newest === undefined || newest.mainRelpath === undefined) {
		throw new Error("no stored transcript session to capture");
	}
	const bytes = store.readStored(daemonId, newest.sessionId, newest.mainRelpath);
	if (bytes === null) throw new Error("stored transcript bytes vanished");
	const pidfile = readPidfile();
	return {
		sessionId: newest.sessionId,
		mainRelpath: newest.mainRelpath,
		bytes,
		pid: pidfile?.pid ?? 0,
	};
}

async function phaseWake(): Promise<void> {
	const before = captureSnapshot();

	const stopped = await ctl("/ctl/stop", { method: "POST", body: { selector: daemonId } });
	acceptance.check(
		"stop succeeds",
		stopped.status === 200,
		`status ${stopped.status}: ${JSON.stringify(stopped.body)}`,
	);
	await waitFor(
		"the workspace to report asleep",
		async () => {
			const row = await sessionRow(daemonId);
			return row !== null && row.status !== "ready" ? row : null;
		},
		{ timeoutMs: STOP_TIMEOUT_MS },
	);

	const volumeSessions = join(workspaceDir, daemonId, ".home", "agent", "sessions");
	acceptance.check(
		"stopped workspace retains its volume",
		existsSync(volumeSessions),
		volumeSessions,
	);
	const afterStop = storedLineage();
	acceptance.check(
		"stopped workspace retains its stored transcript",
		afterStop.sessions.some((session) => session.sessionId === before.sessionId),
		JSON.stringify(afterStop.sessions.map((session) => session.sessionId)),
	);

	const woken = await ctl("/ctl/wake", { method: "POST", body: { daemonId } });
	acceptance.check(
		"wake succeeds",
		woken.status === 200,
		`status ${woken.status}: ${JSON.stringify(woken.body)}`,
	);
	await waitFor(
		"the woken workspace to reach ready",
		async () => {
			const row = await sessionRow(daemonId);
			return row?.status === "ready" ? row : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS },
	);

	const resumed = await waitFor(
		"the same stored session to reappear",
		() => {
			const { sessions } = storedLineage();
			const found = sessions.find((session) => session.sessionId === before.sessionId);
			return found !== undefined ? found : null;
		},
		{ timeoutMs: PAIR_TIMEOUT_MS, intervalMs: 500 },
	);
	acceptance.check(
		"same session id survives the wake",
		resumed.sessionId === before.sessionId,
		`${before.sessionId} -> ${resumed.sessionId}`,
	);
	const after = captureSnapshot();
	acceptance.check(
		"stored transcript bytes are byte-identical after wake",
		after.bytes.length >= before.bytes.length &&
			after.bytes.subarray(0, before.bytes.length).equals(before.bytes),
		`${before.bytes.length} -> ${after.bytes.length}`,
	);
	acceptance.check(
		"wake starts a fresh sandbox process",
		after.pid !== before.pid && after.pid > 0,
		`pid ${before.pid} -> ${after.pid}`,
	);
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Phase 6: delete
// ---------------------------------------------------------------------------

async function phaseDelete(): Promise<void> {
	// Restart the fleet against the same state: durable identity must survive
	// and the still-running sandbox must reconnect.
	const previous = fleet;
	fleet = null;
	await previous?.close();
	await startFleetInstance();
	acceptance.check("fleet restarts on the recorded state", fleet !== null);

	const transport = acceptance.expect(
		fleet === null ? null : transportOf(fleet),
		"restarted fleet exposes the callback transport",
	);
	acceptance.check(
		"roster still holds the clone after restart",
		(await sessionRow(daemonId)) !== null,
	);
	const reconnected = await waitFor(
		"the restarted fleet to reconnect to the sandbox",
		() => (transport.pairStatus(daemonId).paired ? true : null),
		{ timeoutMs: PAIR_TIMEOUT_MS },
	);
	acceptance.check("restarted fleet reconnects to the sandbox", reconnected === true);

	const stopped = await ctl("/ctl/stop", { method: "POST", body: { selector: daemonId } });
	acceptance.check(
		"final stop succeeds",
		stopped.status === 200,
		`status ${stopped.status}: ${JSON.stringify(stopped.body)}`,
	);

	// The verified gate reports the SESSION ids it proved complete (fleet/cli.ts
	// renders it as "verified N session(s)"), not the workspace id, so the
	// check is bound to the stored session this run streamed.
	const storedBeforeRemoval = storedLineage().sessions[0];
	const removed = await ctl("/ctl/remove", { method: "POST", body: { selector: daemonId } });
	const removal = removed.body as { removed?: string[]; verified?: string[] } | null;
	acceptance.check(
		"verified remove succeeds",
		removed.status === 200 && (removal?.removed ?? []).includes(daemonId),
		`status ${removed.status}: ${JSON.stringify(removed.body)}`,
	);
	acceptance.check(
		"deletion gate verified the workspace store",
		storedBeforeRemoval !== undefined &&
			(removal?.verified ?? []).includes(storedBeforeRemoval.sessionId),
		`${JSON.stringify(storedBeforeRemoval?.sessionId ?? null)} vs ${JSON.stringify(removal)}`,
	);
	acceptance.check(
		"deleted workspace volume is gone",
		!existsSync(join(workspaceDir, daemonId)),
		join(workspaceDir, daemonId),
	);
	acceptance.check(
		"deleted workspace store is frozen read-only",
		existsSync(join(logsDir, daemonId, "readonly.json")),
		join(logsDir, daemonId, "readonly.json"),
	);
	acceptance.check("deleted workspace left the roster", (await sessionRow(daemonId)) === null);
	acceptance.settle();
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main(): Promise<never> {
	let blocked: BlockedError | null = null;
	try {
		acceptance.enter("prerequisite");
		await phasePrerequisite();
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
