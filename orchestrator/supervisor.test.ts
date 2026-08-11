/**
 * SpawnSupervisor tests. A FAKE child script (sh) stands in for ompd: it
 * appends its argv (which carries the template-filled token / labels /
 * resume args) to a file, optionally prints the OMPD| listening line for a
 * fake WS daemon the connector dials, and optionally fails. Covers spawn →
 * endpoint resolution → connect, respawn with --resume + fresh token,
 * restart-on-failure with fresh token per attempt, stop (kill + asleep),
 * restart cancellation, and the stderr ring.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { OMPD_PROTO } from "../src/protocol";
import type { OrchestratorConfig } from "./config";
import { DaemonConnector } from "./connector";
import { Registry, type RegistryEntry } from "./registry";
import { SpawnSupervisor } from "./supervisor";

const tmpDirs: string[] = [];

function tmpPath(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

async function waitFor<T>(probe: () => T | null, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(25);
	}
}

interface FakeServer {
	server: Server<undefined>;
	port: number;
	openCount: number;
	headers: Array<Record<string, string>>;
	serverCloses: Array<{ code: number }>;
	stop(): void;
}

/** Fake ompd daemon: primes hello_ok (hello.cwd) → state → ready on every dial. */
function startFake(hello: { cwd: string; sessionFile: string }): FakeServer {
	const fake: FakeServer = {
		server: null as unknown as Server<undefined>,
		port: 0,
		openCount: 0,
		headers: [],
		serverCloses: [],
		stop() {
			this.server.stop(true);
		},
	};
	fake.server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req, srv) {
			fake.openCount++;
			fake.headers.push(Object.fromEntries(req.headers.entries()));
			if (!srv.upgrade(req)) return new Response("upgrade failed", { status: 500 });
		},
		websocket: {
			open(ws) {
				ws.send(
					JSON.stringify({
						type: "hello_ok",
						proto: OMPD_PROTO,
						name: "fake",
						cwd: hello.cwd,
						pid: 4242,
						version: "test",
						sessionFile: hello.sessionFile,
					}),
				);
				ws.send(
					JSON.stringify({
						type: "state",
						sessionId: "s1",
						state: { sessionId: "s1", sessionFile: hello.sessionFile, isStreaming: false },
					}),
				);
				ws.send(JSON.stringify({ type: "ready", readyAt: Date.now() }));
			},
			message() {
				// The fake daemon never receives client frames in these tests.
			},
			close(ws, code) {
				fake.serverCloses.push({ code });
			},
		},
	});
	fake.port = fake.server.port ?? 0;
	return fake;
}

async function loadedRegistry(): Promise<Registry> {
	const registry = new Registry(join(tmpPath("ompd-sup-state-"), "state.json"));
	await registry.load();
	return registry;
}

/**
 * Write a fake child script. It appends "$@" (the template-filled token /
 * labels / resume args) to argsFile, optionally records its pid, prints
 * stderr lines, then either exits 1 (fail) or prints the OMPD| listening
 * line for `port` and idles.
 */
function writeChildScript(dir: string, port: number, argsFile: string, opts: { fail?: boolean; pidFile?: string; stderrLines?: string[] } = {}): string {
	const script = join(dir, "child.sh");
	const lines = [
		"#!/bin/sh",
		'trap "exit 0" TERM INT',
		`echo "$@" >> ${argsFile}`,
	];
	if (opts.pidFile) lines.push(`echo $$ > ${opts.pidFile}`);
	for (const line of opts.stderrLines ?? []) lines.push(`echo ${JSON.stringify(line)} >&2`);
	if (opts.fail) {
		lines.push("exit 1");
	} else {
		lines.push(`printf 'OMPD|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${port},"url":"ws://127.0.0.1:${port}"}'`);
		lines.push("while :; do sleep 1; done");
	}
	writeFileSync(script, lines.join("\n") + "\n");
	return script;
}

/** Spawn template that fills {token} {labels} {resume} as argv for the fake child. */
function makeConfig(script: string): OrchestratorConfig {
	return {
		roots: [],
		templates: { test: { command: `sh ${script} {token} {labels} {resume}` } },
		defaultTemplate: "test",
	};
}

/** Two-template config for resolution-order tests: default "test", override "other". */
function makeTierConfig(scriptDefault: string, scriptOverride: string, projectTemplates?: Record<string, string>): OrchestratorConfig {
	return {
		roots: [],
		templates: {
			test: { command: `sh ${scriptDefault} {token} {labels} {resume}` },
			other: { command: `sh ${scriptOverride} {token} {labels} {resume}` },
		},
		defaultTemplate: "test",
		...(projectTemplates !== undefined ? { projectTemplates } : {}),
	};
}

function makeConnector(registry: Registry): DaemonConnector {
	return new DaemonConnector(registry, undefined, { backoffMinMs: 10, backoffMaxMs: 50 });
}

describe("SpawnSupervisor", () => {
	test("spawn runs the child, resolves the endpoint, and connects to ready", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { pidFile: join(projectDir, "pid.txt") });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeConfig(script), { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir, labels: ["env=prod"] });
		expect(entry.mode).toBe("spawned");
		expect(entry.project).toBe(basename(projectDir));
		expect(entry.status).toBe("spawning");
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 5000, "ready");
		const updated = registry.get(entry.daemonId)!;
		expect(updated.endpoint).toBe(`ws://127.0.0.1:${fake.port}`);
		expect(updated.lastSessionFile).toBe("/srv/proj/sess.jsonl");
		expect(updated.pid).toBeTypeOf("number");
		expect(updated.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(fake.headers[0]?.["authorization"]).toBe(`Bearer ${updated.token}`);
		expect(connector.isConnected(entry.daemonId)).toBe(true);
		const line1 = readFileSync(argsFile, "utf8").split("\n")[0];
		expect(line1).toContain(updated.token!);
		expect(line1).toContain("--label env=prod");

		await supervisor.close();
		await connector.close();
		fake.stop();
	});

	test("respawn uses --resume lastSessionFile and a fresh token; reconnects to ready", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeConfig(script), { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 5000, "ready");
		const firstToken = registry.get(entry.daemonId)!.token;

		await supervisor.respawn(registry.get(entry.daemonId)!);
		// Wait for the NEW child to dial and reach ready — the registry token
		// changes at launch time while the old "ready" status is still stale.
		await waitFor(
			() => {
				const current = registry.get(entry.daemonId)!;
				return fake.openCount >= 2 && current.status === "ready" && current.token !== firstToken ? "ready" : null;
			},
			8000,
			"respawned ready",
		);
		const updated = registry.get(entry.daemonId)!;
		const lines = readFileSync(argsFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe(firstToken!); // first spawn: no resume, bare token
		expect(lines[1]).toContain("--resume /srv/proj/sess.jsonl"); // R3 resume rule
		expect(lines[1]).toContain(updated.token!);
		expect(updated.token!).not.toBe(firstToken!);
		expect(fake.openCount).toBeGreaterThanOrEqual(2);

		await supervisor.close();
		await connector.close();
		fake.stop();
	});

	test("restart-on-failure: bounded restarts with a fresh token per attempt, then error", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { fail: true });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		// restartMax 1: initial child + exactly one restart, then error.
		const supervisor = new SpawnSupervisor(registry, connector, makeConfig(script), { restartMax: 1 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(() => (registry.get(entry.daemonId)?.status === "error" ? registry.get(entry.daemonId)! : null), 10_000, "error status");
		const updated = registry.get(entry.daemonId)!;
		expect(updated.error).toContain("exited");
		const lines = readFileSync(argsFile, "utf8").trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain(updated.token!); // the final attempt's token is registered
		expect(lines[0]).not.toBe(lines[1]); // fresh token across attempts

		await supervisor.close();
		await connector.close();
		fake.stop();
	});

	test("stop kills the child, drops the socket, and sets status asleep", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const pidFile = join(projectDir, "pid.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { pidFile });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeConfig(script), { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 5000, "ready");
		const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		expect(pid).toBeGreaterThan(0);

		await supervisor.stop(entry.daemonId);
		expect(registry.get(entry.daemonId)?.status).toBe("asleep");
		expect(connector.isConnected(entry.daemonId)).toBe(false);
		await waitFor(() => (fake.serverCloses.length >= 1 ? "closed" : null), 2000, "server-observed close");
		let alive = true;
		try {
			process.kill(pid, 0);
		} catch {
			alive = false;
		}
		expect(alive).toBe(false);

		await supervisor.close();
		await connector.close();
		fake.stop();
	});

	test("stop cancels a scheduled restart", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { fail: true });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeConfig(script), { restartMax: 5 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		// The first child exits ~instantly and schedules a restart at ≥500ms;
		// stop() within that window must cancel it.
		await waitFor(() => {
			try {
				return readFileSync(argsFile, "utf8").trim().split("\n").length >= 1 ? "spawned" : null;
			} catch {
				return null; // the child may not have written the file yet
			}
		}, 2000, "first child");
		await supervisor.stop(entry.daemonId);
		expect(registry.get(entry.daemonId)?.status).toBe("asleep");
		await sleep(2200); // the 1s-min backoff would have fired by now if not cancelled
		expect(readFileSync(argsFile, "utf8").trim().split("\n")).toHaveLength(1);

		await supervisor.close();
		await connector.close();
		fake.stop();
	});

	test("stderrTail returns the ring buffer; the ring truncates to stderrRingBytes", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsFile = join(projectDir, "args.txt");
		const script = writeChildScript(projectDir, fake.port, argsFile, { stderrLines: ["boom-one", "boom-two"] });
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeConfig(script), { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 5000, "ready");
		const tail = supervisor.stderrTail(entry.daemonId);
		expect(tail).toContain("boom-one");
		expect(tail).toContain("boom-two");

		await supervisor.stop(entry.daemonId);

		// A small ring keeps only the tail.
		const supervisor2 = new SpawnSupervisor(registry, connector, makeConfig(script), { stderrRingBytes: 8 });
		const entry2 = await supervisor2.spawn({ cwd: projectDir });
		await waitFor(() => (registry.get(entry2.daemonId)?.status === "ready" ? "ready" : null), 5000, "ready 2");
		const smallTail = supervisor2.stderrTail(entry2.daemonId);
		expect(smallTail.length).toBeLessThanOrEqual(8);
		expect(smallTail.endsWith("two\n")).toBe(true);

		await supervisor2.close();
		await connector.close();
		fake.stop();
	});

	test("unknown template rejects and creates nothing", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const script = writeChildScript(projectDir, 1, join(projectDir, "args.txt"));
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeConfig(script), {});
		const before = registry.list().length;
		await expect(supervisor.spawn({ cwd: projectDir, template: "nope" })).rejects.toThrow(/unknown spawn template/);
		expect(registry.list()).toHaveLength(before);
		await supervisor.close();
		await connector.close();
	});

	test("projectTemplates: basename(cwd) picks the template when init.template is absent", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsDefault = join(projectDir, "args-default.txt");
		const argsOverride = join(projectDir, "args-override.txt");
		// Separate dirs: writeChildScript uses a fixed `child.sh` name per dir.
		mkdirSync(join(projectDir, "tpl-default"), { recursive: true });
		mkdirSync(join(projectDir, "tpl-override"), { recursive: true });
		const scriptDefault = writeChildScript(join(projectDir, "tpl-default"), fake.port, argsDefault);
		const scriptOverride = writeChildScript(join(projectDir, "tpl-override"), fake.port, argsOverride);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }), { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 5000, "ready");
		expect(registry.get(entry.daemonId)?.template).toBe("other");
		expect(readFileSync(argsOverride, "utf8").split("\n")[0]).toContain(registry.get(entry.daemonId)!.token!);
		// The default-template child must never have launched.
		expect(existsSync(argsDefault)).toBe(false);

		await supervisor.close();
		await connector.close();
		fake.stop();
	});

	test("init.template wins over projectTemplates", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsDefault = join(projectDir, "args-default.txt");
		const argsOverride = join(projectDir, "args-override.txt");
		mkdirSync(join(projectDir, "tpl-default"), { recursive: true });
		mkdirSync(join(projectDir, "tpl-override"), { recursive: true });
		const scriptDefault = writeChildScript(join(projectDir, "tpl-default"), fake.port, argsDefault);
		const scriptOverride = writeChildScript(join(projectDir, "tpl-override"), fake.port, argsOverride);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeTierConfig(scriptDefault, scriptOverride, { [basename(projectDir)]: "other" }), { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir, template: "test" });
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 5000, "ready");
		expect(registry.get(entry.daemonId)?.template).toBe("test");
		expect(readFileSync(argsDefault, "utf8").split("\n")[0]).toContain(registry.get(entry.daemonId)!.token!);
		expect(existsSync(argsOverride)).toBe(false);

		await supervisor.close();
		await connector.close();
		fake.stop();
	});

	test("defaultTemplate applies when the project has no override", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const fake = startFake({ cwd: projectDir, sessionFile: "/srv/proj/sess.jsonl" });
		const argsDefault = join(projectDir, "args-default.txt");
		const argsOverride = join(projectDir, "args-override.txt");
		mkdirSync(join(projectDir, "tpl-default"), { recursive: true });
		mkdirSync(join(projectDir, "tpl-override"), { recursive: true });
		const scriptDefault = writeChildScript(join(projectDir, "tpl-default"), fake.port, argsDefault);
		const scriptOverride = writeChildScript(join(projectDir, "tpl-override"), fake.port, argsOverride);
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		// The override key deliberately does not match this project's basename.
		const supervisor = new SpawnSupervisor(registry, connector, makeTierConfig(scriptDefault, scriptOverride, { "some-other-project": "other" }), { restartMax: 2 });

		const entry = await supervisor.spawn({ cwd: projectDir });
		await waitFor(() => (registry.get(entry.daemonId)?.status === "ready" ? "ready" : null), 5000, "ready");
		expect(registry.get(entry.daemonId)?.template).toBe("test");
		expect(readFileSync(argsDefault, "utf8").split("\n")[0]).toContain(registry.get(entry.daemonId)!.token!);
		expect(existsSync(argsOverride)).toBe(false);

		await supervisor.close();
		await connector.close();
		fake.stop();
	});

	test("unknown projectTemplates value rejects and creates nothing", async () => {
		const projectDir = tmpPath("ompd-sup-proj-");
		const script = writeChildScript(projectDir, 1, join(projectDir, "args.txt"));
		const registry = await loadedRegistry();
		const connector = makeConnector(registry);
		const supervisor = new SpawnSupervisor(registry, connector, makeTierConfig(script, script, { [basename(projectDir)]: "nope" }), { restartMax: 2 });
		const before = registry.list().length;
		await expect(supervisor.spawn({ cwd: projectDir })).rejects.toThrow(/unknown spawn template: nope/);
		expect(registry.list()).toHaveLength(before);
		await supervisor.close();
		await connector.close();
	});
});
