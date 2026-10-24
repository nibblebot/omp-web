/**
 * The system under test: one out-of-process fleet (`omp-web control` entry,
 * own state/config/workspace dirs and port) whose sessions are real
 * `apps/session/index.ts` daemons spawned through the normal fleet path
 * (spawn templates). Models come from a fake OpenAI-compatible server the
 * harness runs; every session and the fleet share one isolated agent dir, as
 * production sessions share ~/.omp/agent.
 *
 * Pinning: the fleet runs under `taskset -c <fleet cpu>` and each session
 * template carries `taskset -c <session cpu>`, so every thread of every
 * process starts on its core. `verifyPinning` re-reads every thread's
 * Cpus_allowed_list before a rep and repins stragglers.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import type { DaemonEntry } from "#lib/wire/protocol";
import { writeAgentDir } from "./fake-model/config";
import { descendantPids, isAlive, pidsByCmdline } from "./proc";
import { ensureAffinity } from "./pinning";
import type { AffinityRecord, PinPlan } from "./types";

export interface StackOptions {
	repoRoot: string;
	outDir: string;
	pin: PinPlan;
	/** Base URL of the fake model (models.yml baseUrl); a wrong one makes sessions unable to complete turns. */
	fakeModelUrl: string;
	/**
	 * Extra `bun` argv inserted before the entry (e.g. `--cpu-prof` or
	 * `--inspect` flags), per role. A session's list is built per pin slot so
	 * every session can get its own output name or inspector port.
	 */
	bunArgs?: { fleet?: string[]; session?: (slot: number) => string[] };
	/** Run the fleet bare (control plane + UI on one port) so a browser can load the UI; needs `dist/` (`bun run build:web`). */
	serveUi?: boolean;
	/** Extra env for fleet and sessions. */
	extraEnv?: Record<string, string>;
}

export interface SessionSpec {
	/** Stable label (`s1`..`s4`), also the route directive label. */
	label: string;
	/** Pin slot (index into plan.sessions) and template index. */
	slot: number;
}

export interface SessionHandle {
	label: string;
	slot: number;
	cpus: string | undefined;
	repo: string;
	projectId: string;
	daemonId: string;
	name: string;
	/** Daemon pid the fleet reported (may be the sh wrapper). */
	rootPid: number;
	/** The bun session daemon pids (self only, not tool subprocesses). */
	daemonPids(): number[];
	/** Every process under the root pid, tool subprocesses included. */
	treePids(): number[];
}

const SESSION_ENTRY = "apps/session/index.ts";
const SLOTS = 4;

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function freePort(): Promise<number> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
	const port = probe.port;
	await probe.stop(true);
	if (port === undefined) throw new Error("no free port");
	return port;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(`git ${args.join(" ")} failed (${code}): ${err.trim()}`);
}

/** A throwaway git repo with one commit; the user's git identity is used as-is. */
export async function makeRepo(dir: string): Promise<string> {
	mkdirSync(dir, { recursive: true });
	await git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "README.md"), "# profile fixture\n");
	await git(dir, "add", "README.md");
	await git(dir, "commit", "-q", "-m", "init");
	return dir;
}

export class Stack {
	readonly baseUrl: string;
	readonly port: number;
	readonly agentDir: string;
	readonly fleetPid: number;
	readonly #opts: StackOptions;
	readonly #fleet: Bun.Subprocess;
	readonly #sessions = new Map<string, SessionHandle>();
	#stopped = false;

	private constructor(opts: StackOptions, port: number, fleet: Bun.Subprocess, agentDir: string) {
		this.#opts = opts;
		this.port = port;
		this.baseUrl = `http://127.0.0.1:${port}`;
		this.#fleet = fleet;
		this.fleetPid = fleet.pid;
		this.agentDir = agentDir;
	}

	static async start(opts: StackOptions): Promise<Stack> {
		const { outDir, repoRoot, pin } = opts;
		const agentDir = join(outDir, "agent");
		const stateDir = join(outDir, "fleet");
		mkdirSync(stateDir, { recursive: true });
		await writeAgentDir(agentDir, opts.fakeModelUrl);
		const port = await freePort();
		const bun = process.execPath;
		const scrubKeys = Object.keys(process.env).filter(
			(k) => k.endsWith("_API_KEY") || k.endsWith("_AUTH_TOKEN"),
		);
		const scrub = scrubKeys.length === 0 ? "" : `env ${scrubKeys.map((k) => `-u ${k}`).join(" ")} `;
		const extraEnv = Object.entries(opts.extraEnv ?? {})
			.map(([k, v]) => `${k}=${v}`)
			.join(" ");
		const templates: Record<string, { command: string }> = {};
		for (let slot = 0; slot < SLOTS; slot++) {
			const cpus = pin.enabled ? pin.sessions[slot] : undefined;
			const taskset = cpus === undefined ? "" : `taskset -c ${cpus} `;
			templates[`s${slot + 1}`] = {
				command:
					`${scrub}PI_CODING_AGENT_DIR=${agentDir} PI_AUTH_NO_BORROW=1 PI_NO_TITLE=1 ${extraEnv} ${taskset}` +
					`${bun} ${(opts.bunArgs?.session?.(slot) ?? []).join(" ")} ${join(repoRoot, SESSION_ENTRY)} --cwd {cwd} --port 0 {fleet} --name {name} {resume}`,
			};
		}
		const configPath = join(stateDir, "config.json");
		writeFileSync(configPath, JSON.stringify({ templates, defaultTemplate: "s1" }));
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v === undefined) continue;
			if (k.startsWith("OMP_FLEET_") || scrubKeys.includes(k)) continue;
			env[k] = v;
		}
		Object.assign(env, opts.extraEnv ?? {}, {
			OMP_FLEET_STATE: join(stateDir, "state.json"),
			OMP_FLEET_CONFIG: configPath,
			PI_CODING_AGENT_DIR: agentDir,
			PI_AUTH_NO_BORROW: "1",
			PI_NO_TITLE: "1",
		});
		const taskset = pin.enabled ? ["taskset", "-c", pin.fleet] : [];
		const log = Bun.file(join(outDir, "fleet.log"));
		const argv = [
			...taskset,
			bun,
			...(opts.bunArgs?.fleet ?? []),
			join(repoRoot, "apps/fleet/cli.ts"),
			...(opts.serveUi === true ? ["--no-open"] : ["control"]),
			"--port",
			String(port),
			"--workspace-dir",
			join(outDir, "workspaces"),
		];
		const fleet = Bun.spawn(argv, {
			cwd: repoRoot,
			env,
			stdin: "ignore",
			stdout: log,
			stderr: log,
		});
		const stack = new Stack(opts, port, fleet, agentDir);
		try {
			await stack.#waitFleet();
		} catch (err) {
			await stack.stop();
			throw err;
		}
		return stack;
	}

	async #waitFleet(): Promise<void> {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if (this.#fleet.exitCode !== null) {
				throw new Error(
					`fleet exited early (${this.#fleet.exitCode}); see ${join(this.#opts.outDir, "fleet.log")}`,
				);
			}
			try {
				const res = await fetch(`${this.baseUrl}/ctl/sessions`);
				if (res.status === 200) return;
			} catch {
				// not listening yet
			}
			await sleep(100);
		}
		throw new Error("fleet did not come up within 30s");
	}

	async ctl<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
		const init: RequestInit =
			body === undefined
				? { method }
				: { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
		const res = await fetch(`${this.baseUrl}${path}`, init);
		const text = await res.text();
		if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
		return (text === "" ? undefined : JSON.parse(text)) as T;
	}

	/** Live sessions the stack started, in start order. */
	get sessions(): SessionHandle[] {
		return [...this.#sessions.values()];
	}

	roster(): Promise<DaemonEntry[]> {
		return this.ctl<DaemonEntry[]>("GET", "/ctl/sessions");
	}

	/** The session directory the SDK uses for `cwd` under this stack's agent dir. */
	sessionDirFor(cwd: string): string {
		return SessionManager.getDefaultSessionDir(cwd, this.agentDir, new FileSessionStorage());
	}

	/**
	 * Register `repo` as a project and start its main-checkout session through
	 * the fleet (template `s<slot+1>`), waiting for status `ready`. With
	 * `start:false` the row stays asleep (S1 resumes a fixture file later).
	 */
	async addSession(
		spec: SessionSpec,
		repo: string,
		opts: { start?: boolean } = {},
	): Promise<SessionHandle> {
		const start = opts.start ?? true;
		const res = await this.ctl<{
			project: { projectId: string };
			entry?: DaemonEntry;
			existing?: boolean;
		}>("POST", "/ctl/projects", { path: repo, start, template: `s${spec.slot + 1}` });
		if (res.existing) throw new Error(`project ${repo} already registered`);
		const roster = await this.roster();
		const row = roster.find((d) => d.projectId === res.project.projectId && d.cwd === repo);
		if (row === undefined) throw new Error(`no roster row for project ${res.project.projectId}`);
		const handle: SessionHandle = {
			label: spec.label,
			slot: spec.slot,
			cpus: this.#opts.pin.enabled ? this.#opts.pin.sessions[spec.slot] : undefined,
			repo,
			projectId: res.project.projectId,
			daemonId: row.daemonId,
			name: row.name,
			rootPid: row.pid ?? 0,
			daemonPids: () => this.#daemonPids(row.name, handle.rootPid),
			treePids: () => (handle.rootPid > 0 ? descendantPids(handle.rootPid) : []),
		};
		this.#sessions.set(spec.label, handle);
		if (start) await this.waitReady(handle);
		return handle;
	}

	#daemonPids(name: string, rootPid: number): number[] {
		const tree = new Set(rootPid > 0 ? descendantPids(rootPid) : []);
		const out = pidsByCmdline(
			(argv) =>
				argv.some((a) => a.endsWith(SESSION_ENTRY)) && argv.includes(name) && argv[0] !== "sh",
		);
		const inTree = out.filter((p) => tree.has(p));
		return inTree.length > 0 ? inTree : out;
	}

	/** Wait for the roster row to be `ready` with a session file, refreshing the pid. */
	async waitReady(handle: SessionHandle, timeoutMs = 60_000): Promise<DaemonEntry> {
		const deadline = Date.now() + timeoutMs;
		let last: DaemonEntry | undefined;
		while (Date.now() < deadline) {
			last = (await this.roster()).find((d) => d.daemonId === handle.daemonId);
			if (last?.status === "ready" && last.lastSessionFile !== undefined) {
				if (last.pid !== undefined) handle.rootPid = last.pid;
				return last;
			}
			if (last?.status === "error") throw new Error(`session ${handle.label} error: ${last.error}`);
			await sleep(60);
		}
		throw new Error(`session ${handle.label} not ready in ${timeoutMs}ms (status ${last?.status})`);
	}

	/** Pin-verify every session in `handles` plus the fleet; returns the records. */
	async verifyPinning(handles: SessionHandle[]): Promise<AffinityRecord[]> {
		const { pin } = this.#opts;
		if (!pin.enabled) return [];
		const out: AffinityRecord[] = [];
		out.push(...(await ensureAffinity("fleet", [this.fleetPid], pin.fleet)));
		for (const h of handles) {
			const cpus = pin.sessions[h.slot];
			const pids = h.treePids();
			if (pids.length === 0) continue;
			out.push(...(await ensureAffinity(`session:${h.label}`, pids, cpus)));
		}
		return out;
	}

	/**
	 * Keep the session's process log under `<outDir>/session-logs/`: the fleet
	 * deletes it with the session, and it is the evidence when a run misbehaves.
	 */
	#saveSessionLog(handle: SessionHandle): void {
		const source = join(this.#opts.outDir, "fleet", "session-logs", `${handle.daemonId}.log`);
		if (!existsSync(source)) return;
		const dir = join(this.#opts.outDir, "session-logs");
		mkdirSync(dir, { recursive: true });
		copyFileSync(source, join(dir, `${handle.name}.log`));
	}

	/** Stop the session and deregister its project (transcripts stay on disk). */
	async removeSession(handle: SessionHandle): Promise<void> {
		this.#saveSessionLog(handle);
		this.#sessions.delete(handle.label);
		const pids = handle.treePids();
		await this.ctl("DELETE", `/ctl/projects/${encodeURIComponent(handle.projectId)}`).catch(
			() => undefined,
		);
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline && pids.some((p) => isAlive(p))) await sleep(50);
	}

	/** Stop every session and the fleet, then sweep stragglers naming the run dir. */
	async stop(): Promise<void> {
		if (this.#stopped) return;
		this.#stopped = true;
		for (const handle of this.#sessions.values()) {
			this.#saveSessionLog(handle);
			await this.ctl("POST", "/ctl/stop", { selector: handle.daemonId }).catch(() => undefined);
		}
		this.#sessions.clear();
		if (this.#fleet.exitCode === null) {
			this.#fleet.kill("SIGTERM");
			await Promise.race([this.#fleet.exited, sleep(10_000)]);
			if (this.#fleet.exitCode === null) this.#fleet.kill("SIGKILL");
		}
		reapLeftovers(this.#opts.outDir);
		await sleep(100);
		reapLeftovers(this.#opts.outDir, "SIGKILL");
	}
}

/** Kill any process whose argv names `outDir` (sessions outlive the fleet by design). */
export function reapLeftovers(outDir: string, signal: NodeJS.Signals = "SIGTERM"): number[] {
	// The fake model process (its send log lives under the run dir) is owned by the runner.
	const pids = pidsByCmdline(
		(argv) =>
			argv.some((a) => a.includes(outDir)) && !argv.some((a) => a.endsWith("fake-process-main.ts")),
	);
	for (const pid of pids) {
		if (pid === process.pid) continue;
		try {
			process.kill(pid, signal);
		} catch {
			// gone
		}
	}
	return pids;
}

/** Remove a run's scratch dirs the harness owns (kept: summary + logs). */
export function removeRunScratch(outDir: string): void {
	for (const name of ["workspaces", "repos"])
		rmSync(join(outDir, name), { recursive: true, force: true });
}
