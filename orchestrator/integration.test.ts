/**
 * Real-daemon end-to-end integration suite (orchestrator core).
 *
 * Boots a real orchestrator (startOrchestrator) on an ephemeral loopback port
 * with tmp state + config, spawns THREE real ompd daemons (bun server/index.ts
 * via the configured local spawn template) over the HTTP control plane,
 * prompts each, SIGKILLs one child and asserts the supervisor's
 * restart-on-failure (fresh token per attempt, --resume of the known session
 * file), `add`s an externally launched ompd and drives it, then exercises the
 * idle auto-exit → asleep → respawn-on-demand-with---resume lifecycle on a
 * short-idle daemon.
 *
 * Real model prompts issued: exactly 5 (d1, d2, d3, the added external daemon,
 * and the respawned idle daemon). Tests are serial and share one orchestrator
 * instance; waits are generous and every timeout failure includes the daemon's
 * stderr tail when the supervisor can provide it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOrchestrator, type OrchestratorServer } from "./server";
import type { RegistryEntry } from "./registry";
import { parseOmpdLine } from "./spawn-parse";

const PROMPT_TEXT = "Reply with exactly: PONG";

/** Local spawn template: real ompd via bun; the child's cwd is the repo root (inherited). */
const LOCAL_TEMPLATE = "bun server/index.ts --cwd {cwd} --port 0 --token {token} --name {name} {labels} {resume}";
/** Same, with a short idle auto-exit so the R11 lifecycle is testable in seconds. */
const SHORTIDLE_TEMPLATE = "bun server/index.ts --cwd {cwd} --port 0 --token {token} --name {name} --idle-timeout 3s {labels} {resume}";

interface PromptResultWire {
	daemonId: string;
	ok: boolean;
	text?: string;
	error?: string;
}

/** The externally launched ompd we manage ourselves (step 5). */
interface ExtDaemon {
	child: { pid: number; kill(signal?: string): void; exited: Promise<number | null> };
	url: string;
}

/**
 * Polling here deliberately uses real wall-clock time: the daemons under test
 * are separate OS processes with their own clocks (model latency, ompd's idle
 * timer, the supervisor's restart backoff). Deterministic fake timers cannot
 * drive them, so the waits below await real status transitions instead.
 */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

describe("orchestrator integration — real ompd daemons", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let projDirs: string[];
	let server!: OrchestratorServer;
	let d1!: RegistryEntry;
	let d2!: RegistryEntry;
	let d3!: RegistryEntry;
	let d4!: RegistryEntry;
	let ext!: ExtDaemon;
	let extEntry!: RegistryEntry;
	/** Every child pid we have seen (spawn responses + restarts + external). */
	const trackedPids = new Set<number>();
	/** Real model prompts issued through the control plane. */
	let promptCount = 0;

	const base = (): string => `http://127.0.0.1:${server.port}`;

	function postJson(path: string, body: unknown): Promise<Response> {
		return fetch(`${base()}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	async function listDaemons(): Promise<RegistryEntry[]> {
		const res = await fetch(`${base()}/ctl/daemons`);
		if (res.status !== 200) throw new Error(`GET /ctl/daemons → ${res.status}`);
		return (await res.json()) as RegistryEntry[];
	}

	async function getEntry(id: string): Promise<RegistryEntry | undefined> {
		return (await listDaemons()).find((entry) => entry.daemonId === id);
	}

	/**
	 * Poll GET /ctl/daemons until `predicate(entry)` holds. Every observed
	 * status is recorded; a timeout (or an error status) throws with the
	 * daemon's stderr tail when available.
	 */
	async function waitForEntry(
		id: string,
		predicate: (entry: RegistryEntry) => boolean,
		timeoutMs: number,
		what: string,
	): Promise<{ entry: RegistryEntry; seen: string[] }> {
		const deadline = Date.now() + timeoutMs;
		const seen: string[] = [];
		let last: RegistryEntry | undefined;
		while (Date.now() < deadline) {
			last = await getEntry(id);
			if (last) {
				seen.push(last.status);
				if (predicate(last)) return { entry: last, seen };
				if (last.status === "error") {
					const tail = server.supervisor.stderrTail(id);
					throw new Error(
						`daemon ${id} entered error: ${last.error ?? "unknown"}${tail ? `\nstderr tail: ${tail.slice(-500)}` : ""}`,
					);
				}
			}
			await sleep(60);
		}
		const tail = server.supervisor.stderrTail(id);
		throw new Error(
			`timed out waiting for ${id} to ${what} (${timeoutMs}ms); last status: ${last?.status ?? "absent"}${tail ? `\nstderr tail: ${tail.slice(-500)}` : ""}`,
		);
	}

	/** One real prompt through POST /ctl/prompt with correlation (waitMs). */
	async function ctlPrompt(selector: string, waitMs: number): Promise<PromptResultWire> {
		promptCount++;
		const res = await postJson("/ctl/prompt", { selector, text: PROMPT_TEXT, waitMs });
		expect(res.status).toBe(200);
		const body = (await res.json()) as PromptResultWire[];
		expect(body).toHaveLength(1);
		if (!body[0].ok) console.error(`[integration] prompt ${selector} failed:`, JSON.stringify(body[0]));
		return body[0];
	}

	/** Launch `bun server/index.ts` ourselves and parse its OMPD| listening line. */
	async function spawnExternal(cwd: string, token: string, name: string, extraArgs: string[]): Promise<ExtDaemon> {
		const command = ["bun", "server/index.ts", "--cwd", cwd, "--port", "0", "--token", token, "--name", name, ...extraArgs].join(" ");
		const child = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
		const reader = child.stdout.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let url: string | undefined;
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline && url === undefined) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				const parsed = parseOmpdLine(line);
				if (parsed?.event === "listening" && url === undefined) url = parsed.url;
			}
		}
		// Keep draining both pipes in the background so nothing ever blocks the daemon.
		void drain(reader);
		void drain(child.stderr.getReader());
		if (url === undefined) {
			try {
				child.kill("SIGKILL");
			} catch {
				// already gone
			}
			throw new Error(`external ompd ${name} printed no OMPD| listening line within 30s`);
		}
		return { child: child as unknown as ExtDaemon["child"], url };
	}

	async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
		try {
			for (;;) {
				const { done } = await reader.read();
				if (done) break;
			}
		} catch {
			// Pipe closed — the daemon is gone; nothing to drain.
		}
	}

	beforeAll(async () => {
		if (!existsSync(join(process.cwd(), "server", "index.ts"))) {
			throw new Error(
				"integration tests must run from the repo root: bun test orchestrator/integration.test.ts",
			);
		}
		tmp = mkdtempSync(join(tmpdir(), "omp-orch-integration-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		const projectsRoot = join(tmp, "projects");
		mkdirSync(projectsRoot, { recursive: true });
		projDirs = [join(projectsRoot, "proj-a"), join(projectsRoot, "proj-b"), join(projectsRoot, "proj-c")];
		for (const dir of projDirs) mkdirSync(dir, { recursive: true });
		writeFileSync(
			configPath,
			JSON.stringify({
				roots: [projectsRoot],
				templates: { local: { command: LOCAL_TEMPLATE }, shortidle: { command: SHORTIDLE_TEMPLATE } },
				defaultTemplate: "local",
			}),
		);
		server = await startOrchestrator({ port: 0, statePath, configPath });
	});

	afterAll(async () => {
		// Collect every pid we know about BEFORE the HTTP server goes away.
		const pids = new Set<number>(trackedPids);
		if (server !== undefined) {
			try {
				for (const entry of await listDaemons()) {
					if (typeof entry.pid === "number") pids.add(entry.pid);
				}
			} catch {
				// Server already stopped.
			}
			await server.close();
			await sleep(400);
		}
		// SIGKILL any stragglers (also the real child of a sh wrapper, if one exists).
		for (const pid of pids) {
			try {
				const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
					.trim()
					.split(/\s+/)
					.filter(Boolean)
					.map(Number);
				for (const childPid of children) {
					try {
						process.kill(childPid, "SIGKILL");
					} catch {
						// gone
					}
				}
			} catch {
				// Process already gone.
			}
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// gone
			}
		}
		if (tmp) rmSync(tmp, { recursive: true, force: true });
	});

	test("boots the control plane against a fresh tmp state", async () => {
		const res = await fetch(`${base()}/ctl/daemons`);
		expect(res.status).toBe(200);
		expect((await res.json()) as unknown[]).toEqual([]);
	});

	test("spawns three real daemons; all reach ready through the status ladder", async () => {
		const mk = (cwd: string, name: string, labels?: string[]) => postJson("/ctl/spawn", { cwd, name, labels });
		const [r1, r2, r3] = await Promise.all([
			mk(projDirs[0], "d-one", ["env=integration"]),
			mk(projDirs[1], "d-two"),
			mk(projDirs[2], "d-three"),
		]);
		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(r3.status).toBe(200);
		d1 = (await r1.json()) as RegistryEntry;
		d2 = (await r2.json()) as RegistryEntry;
		d3 = (await r3.json()) as RegistryEntry;
		expect(d1.mode).toBe("spawned");
		expect(d1.status).toBe("spawning");
		expect(d1.labels).toEqual(["env=integration"]);
		trackedPids.add(d1.pid!);
		trackedPids.add(d2.pid!);
		trackedPids.add(d3.pid!);
		const isReady = (entry: RegistryEntry) => entry.status === "ready";
		const [a, b, c] = await Promise.all([
			waitForEntry(d1.daemonId, isReady, 60_000, "become ready"),
			waitForEntry(d2.daemonId, isReady, 60_000, "become ready"),
			waitForEntry(d3.daemonId, isReady, 60_000, "become ready"),
		]);
		// Status machine evidence: the connector dialed (connecting) before the
		// readiness gate cleared. The session/resolving rungs are too fast to
		// guarantee observation; connecting persists for the whole boot.
		const ladder = [...new Set(a.seen)];
		expect(ladder.at(-1)).toBe("ready");
		expect(ladder).toContain("connecting");
		expect(b.entry.status).toBe("ready");
		expect(c.entry.status).toBe("ready");
	}, 180_000);

	test("prompts each spawned daemon; every turn returns PONG (3 real prompts)", async () => {
		for (const entry of [d1, d2, d3]) {
			const result = await ctlPrompt(entry.daemonId, 90_000);
			expect(result.ok).toBe(true);
			expect(result.error).toBeUndefined();
			expect(result.text).toContain("PONG");
		}
	}, 300_000);

	test("SIGKILL one child: roster shows reconnecting, supervisor restarts with a fresh token", async () => {
		const before = (await getEntry(d2.daemonId))!;
		const tokenBefore = before.token!;
		const pidBefore = before.pid!;
		const sessionBefore = before.lastSessionFile!;
		expect(tokenBefore).toBeTruthy();
		expect(pidBefore).toBeGreaterThan(0);
		expect(sessionBefore).toBeTruthy(); // d2 was prompted; the session file is known
		try {
			process.kill(pidBefore, "SIGKILL");
		} catch {
			// Already gone; the waits below still prove the recovery path.
		}
		// The connector must surface the crash before the supervisor relaunches.
		const reconnecting = await waitForEntry(d2.daemonId, (e) => e.status === "reconnecting", 30_000, "report reconnecting");
		expect(reconnecting.seen).toContain("reconnecting");
		// Then the supervisor restarts the child (fresh token, new pid) and it returns to ready.
		const recovered = await waitForEntry(
			d2.daemonId,
			(e) => e.status === "ready" && e.token !== tokenBefore,
			90_000,
			"recover to ready with a fresh token",
		);
		const after = recovered.entry;
		expect(after.token).not.toBe(tokenBefore);
		expect(after.pid).not.toBe(pidBefore);
		trackedPids.add(after.pid!);
		// The fresh token is persisted: every registry mutation writes state.json.
		const disk = JSON.parse(readFileSync(statePath, "utf8")) as { entries: RegistryEntry[] };
		expect(disk.entries.find((e) => e.daemonId === d2.daemonId)?.token).toBe(after.token);
		// R3 on the crash path: the restarted child resumed the same session file.
		expect(after.lastSessionFile).toBe(sessionBefore);
	}, 180_000);

	test("add an externally launched ompd and drive it (1 real prompt)", async () => {
		ext = await spawnExternal(projDirs[1], "ext-token-123", "ext-drive", ["--idle-timeout", "0"]);
		trackedPids.add(ext.child.pid);
		const res = await postJson("/ctl/add", { name: "ext-drive", url: ext.url, token: "ext-token-123" });
		expect(res.status).toBe(200);
		extEntry = (await res.json()) as RegistryEntry;
		expect(extEntry.mode).toBe("remote");
		const ready = await waitForEntry(extEntry.daemonId, (e) => e.status === "ready", 60_000, "become ready");
		// hello_ok.cwd is adopted for `add`ed entries without a registered cwd.
		expect(ready.entry.cwd).toBe(projDirs[1]);
		const result = await ctlPrompt(extEntry.daemonId, 90_000);
		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.text).toContain("PONG");
		// We launched it, we stop it.
		ext.child.kill("SIGTERM");
		await ext.child.exited;
	}, 200_000);

	test("short-idle daemon: disconnect → idle exit → asleep (session file retained)", async () => {
		const res = await postJson("/ctl/spawn", { cwd: projDirs[2], name: "d-four", template: "shortidle" });
		expect(res.status).toBe(200);
		d4 = (await res.json()) as RegistryEntry;
		const ready = await waitForEntry(d4.daemonId, (e) => e.status === "ready", 60_000, "become ready");
		const sessionBefore = ready.entry.lastSessionFile;
		expect(sessionBefore).toBeTruthy();
		trackedPids.add(ready.entry.pid!);
		// Drop the orchestrator's socket; ompd's idle timer only fires with NO
		// attached clients (3s idle + 15s check tick → clean exit within ~20s).
		server.connector.disconnect(d4.daemonId);
		const asleep = await waitForEntry(d4.daemonId, (e) => e.status === "asleep", 60_000, "go asleep after idle exit");
		// Asleep keeps cwd + lastSessionFile for the respawn-on-demand rule.
		expect(asleep.entry.cwd).toBe(projDirs[2]);
		expect(asleep.entry.lastSessionFile).toBe(sessionBefore);
	}, 150_000);

	test("asleep daemon respawns on demand with --resume (1 real prompt; same session file)", async () => {
		const before = (await getEntry(d4.daemonId))!;
		const sessionBefore = before.lastSessionFile!;
		expect(sessionBefore).toBeTruthy();
		// Note: ompd creates the session log lazily on the first turn, so a
		// never-prompted daemon's file may not exist on disk yet — the resume
		// proof is the path identity across the respawn, checked below.
		const result = await ctlPrompt(d4.daemonId, 90_000);
		expect(result.ok).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.text).toContain("PONG");
		const after = (await getEntry(d4.daemonId))!;
		expect(after.status).toBe("ready");
		// Same session file across the respawn proves the new child got --resume.
		expect(after.lastSessionFile).toBe(sessionBefore);
		// The resumed session wrote its first turn into the SAME file: it now
		// exists on disk (a fresh session would have minted a new path).
		expect(existsSync(sessionBefore)).toBe(true);
		// Disk evidence: state.json keeps the same lastSessionFile through the respawn.
		const disk = JSON.parse(readFileSync(statePath, "utf8")) as { entries: RegistryEntry[] };
		expect(disk.entries.find((e) => e.daemonId === d4.daemonId)?.lastSessionFile).toBe(sessionBefore);
		// Accounting: exactly 5 real model prompts across the suite.
		expect(promptCount).toBe(5);
	}, 200_000);
});
