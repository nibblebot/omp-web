/**
 * Control-plane tests for orchestrator/server.ts: every route exercised over
 * loopback HTTP against a real DaemonConnector + a tiny fake ompd WS daemon
 * (speaking hello_ok/state/ready/event frames, mirroring server/index.ts's
 * handshake: hello_ok only after a valid hello... which the connector never
 * sends, so the fake primes hello_ok → state → ready on open per OCore's
 * dial contract). No real ompd children are spawned.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { OMPD_PROTO } from "../src/protocol";
import type { RegistryEntry } from "./registry";
import { Registry } from "./registry";
import { runSpawnHook, startOrchestrator, type OrchestratorServer } from "./server";
import { main } from "./cli";

const FAKE_CWD = "/tmp/fake-proj";
const FAKE_SESSION_FILE = "/tmp/fake-proj/.omp/session.json";

const FAKE_STATE = {
	model: undefined,
	modelRoles: undefined,
	thinkingLevel: undefined,
	isStreaming: false,
	isCompacting: false,
	steeringMode: "all",
	followUpMode: "all",
	interruptMode: "immediate",
	sessionFile: FAKE_SESSION_FILE,
	sessionId: "s1",
	readyAt: Date.now(),
	sessionName: undefined,
	autoCompactionEnabled: true,
	autoRetryEnabled: true,
	messageCount: 0,
	queuedMessageCount: 0,
	todoPhases: [],
	systemPrompt: undefined,
	dumpTools: undefined,
	contextUsage: undefined,
	goalModeState: undefined,
	planModeEnabled: false,
	fastModeEnabled: false,
	computerToolEnabled: false,
	inspectImageMode: "disabled",
};

interface FakeSeen {
	authHeader: string | null;
	calls: unknown[];
	closed: boolean;
}

interface FakeDaemon {
	url: string;
	port: number;
	seen: FakeSeen;
	close(): void;
}

/** Tiny fake ompd: records the Bearer header, primes the status machine, answers prompt calls. */
function startFakeDaemon(token: string): FakeDaemon {
	const seen: FakeSeen = { authHeader: null, calls: [], closed: false };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			seen.authHeader = req.headers.get("authorization");
			if (srv.upgrade(req)) return undefined;
			return new Response("expected websocket", { status: 400 });
		},
		websocket: {
			open(ws) {
				prime(ws);
			},
			message(ws, raw) {
				let msg: unknown;
				try {
					msg = JSON.parse(String(raw));
				} catch {
					return;
				}
				seen.calls.push(msg);
				const cmd = msg as { type?: string; id?: string; method?: string };
				if (cmd.type === "hello") prime(ws);
				if (cmd.type === "call" && cmd.method === "prompt" && cmd.id !== undefined) answerTurn(ws, cmd.id);
			},
			close() {
				seen.closed = true;
			},
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		port: server.port!,
		seen,
		close: () => server.stop(true),
	};
}

function prime(ws: ServerWebSocket<unknown>) {
	ws.send(JSON.stringify({ type: "hello_ok", proto: OMPD_PROTO, name: "fake", cwd: FAKE_CWD, pid: 4242, version: "0.0.0-test", sessionFile: FAKE_SESSION_FILE }));
	ws.send(JSON.stringify({ type: "state", sessionId: "s1", state: FAKE_STATE }));
	ws.send(JSON.stringify({ type: "ready", readyAt: Date.now() }));
}

function answerTurn(ws: ServerWebSocket<unknown>, callId: string) {
	ws.send(JSON.stringify({ type: "call_result", id: callId, ok: true }));
	ws.send(JSON.stringify({ type: "event", sessionId: "s1", event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fake reply" }] } } }));
	ws.send(JSON.stringify({ type: "event", sessionId: "s1", event: { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "fake reply" }] }] } }));
}

/** Poll until `predicate` is truthy or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${what}`);
}

function postJson(port: number, path: string, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("orchestrator control plane", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: OrchestratorServer;
	let fake: FakeDaemon;
	let entry: RegistryEntry;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-orch-test-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		const rootsDir = join(tmp, "roots");
		mkdirSync(rootsDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ roots: [rootsDir] }));
		server = await startOrchestrator({ port: 0, statePath, configPath });
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
		if (fake !== undefined) fake.close();
	});

	test("GET /ctl/daemons reflects the registry (empty at boot)", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/daemons`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(0);
	});

	test("GET /ctl/projects returns an array (empty roots)", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/projects`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(0);
	});

	test("POST /ctl/spawn 400s on a nonexistent path", async () => {
		const res = await postJson(server.port, "/ctl/spawn", { cwd: join(tmp, "does-not-exist") });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("POST /ctl/provision 400s when no spawnHook is configured", async () => {
		const res = await postJson(server.port, "/ctl/provision", { name: "sandbox" });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("spawn hook");
	});

	test("POST /ctl/add 400s on invalid JSON", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/add`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
	});

	test("POST /ctl/add creates a remote entry and the connector dials with the Bearer header", async () => {
		fake = startFakeDaemon("sekret");
		const res = await postJson(server.port, "/ctl/add", { name: "added", url: fake.url, token: "sekret" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry;
		expect(body.mode).toBe("remote");
		expect(body.status).toBe("connecting");
		entry = body;
		// The connector must dial the fake and present the Bearer header.
		await waitFor(() => fake.seen.authHeader !== null, 5000, "fake daemon dial");
		expect(fake.seen.authHeader).toBe("Bearer sekret");
		// hello_ok.cwd is adopted when the entry had no cwd.
		await waitFor(() => server.registry.get(entry.daemonId)?.status === "ready", 5000, "daemon ready");
		expect(server.registry.get(entry.daemonId)?.cwd).toBe(FAKE_CWD);
	});

	test("daemons list reflects the registry after add", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/daemons`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry[];
		const found = body.find((e) => e.daemonId === entry.daemonId);
		expect(found).toBeDefined();
		expect(found?.name).toBe("added");
		expect(found?.status).toBe("ready");
		expect(found?.endpoint).toBe(fake.url);
	});

	test("POST /ctl/prompt with an unknown selector 404s", async () => {
		const res = await postJson(server.port, "/ctl/prompt", { selector: "d999", text: "hi" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/prompt without waitMs returns { submitted } and dispatches", async () => {
		const res = await postJson(server.port, "/ctl/prompt", { selector: entry.daemonId, text: "ping" });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { submitted?: unknown };
		expect(body.submitted).toEqual([entry.daemonId]);
		// The background dispatch must reach the fake (prompt call observed).
		await waitFor(() => fake.seen.calls.some((c) => (c as { type?: string; method?: string }).type === "call" && (c as { method?: string }).method === "prompt"), 5000, "prompt call on fake");
	});

	test("POST /ctl/prompt with waitMs returns PromptResult[]", async () => {
		const res = await postJson(server.port, "/ctl/prompt", { selector: entry.daemonId, text: "hello there", waitMs: 5000 });
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ daemonId?: string; ok?: boolean; text?: string; error?: string }>;
		expect(body).toHaveLength(1);
		expect(body[0]?.daemonId).toBe(entry.daemonId);
		expect(body[0]?.ok).toBe(true);
		expect(body[0]?.error).toBeUndefined();
	});

	test("POST /ctl/stop 404s on an unknown selector", async () => {
		const res = await postJson(server.port, "/ctl/stop", { selector: "nope" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/stop marks a remote entry asleep", async () => {
		const res = await postJson(server.port, "/ctl/stop", { selector: entry.daemonId });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { stopped?: unknown };
		expect(body.stopped).toEqual([entry.daemonId]);
		expect(server.registry.get(entry.daemonId)?.status).toBe("asleep");
	});

	test("unknown route 404s", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/nope`);
		expect(res.status).toBe(404);
	});
});

describe("POST /ctl/provision (spawn hook)", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let hookPath: string;
	let envFile: string;
	let hookServer: OrchestratorServer;
	let hookFake: FakeDaemon;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-orch-provision-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		envFile = join(tmp, "hook-env.txt");
		hookFake = startFakeDaemon("hook-token");
		hookPath = join(tmp, "hook.sh");
		writeHappyHook();
		// `sh -c <path>` needs the exec bit; rewrites below keep the mode.
		chmodSync(hookPath, 0o755);
		writeFileSync(configPath, JSON.stringify({ roots: [], spawnHook: hookPath }));
		hookServer = await startOrchestrator({ port: 0, statePath, configPath });
	});

	afterAll(async () => {
		if (hookServer !== undefined) await hookServer.close();
		if (hookFake !== undefined) hookFake.close();
	});

	/** The shared hook: records its env, prints noise, then last-line JSON (name/url/token/cwd). */
	function writeHappyHook(): void {
		writeFileSync(
			hookPath,
			[
				"#!/bin/sh",
				`echo "name=$OMP_HOOK_NAME" >> ${envFile}`,
				`echo "labels=$OMP_HOOK_LABELS" >> ${envFile}`,
				"echo 'provisioning sandbox...'", // noise: must not break parsing
				"echo 'still working...'",
				`printf '{"name":"hook-%s","url":"ws://127.0.0.1:${hookFake.port}","token":"hook-token","cwd":"/srv/sandbox"}\\n' "$OMP_HOOK_NAME"`,
				"echo ''", // trailing blank line: last NON-empty line is the JSON
			].join("\n") + "\n",
		);
	}

	test("happy path: hook JSON → remote entry created and dialed with the Bearer token", async () => {
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "sandbox-a", labels: ["env=prod", "team=x"] });
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry;
		expect(body.mode).toBe("remote");
		expect(body.name).toBe("hook-sandbox-a"); // hook name wins over the requested name
		expect(body.labels).toEqual(["env=prod", "team=x"]);
		expect(body.cwd).toBe("/srv/sandbox");
		expect(body.project).toBe("sandbox");
		expect(body.endpoint).toBe(`ws://127.0.0.1:${hookFake.port}`);
		expect(body.token).toBe("hook-token");
		expect(body.status).toBe("connecting");
		// The connector must dial the printed endpoint with the Bearer token.
		await waitFor(() => hookFake.seen.authHeader !== null, 5000, "provision dial");
		expect(hookFake.seen.authHeader).toBe("Bearer hook-token");
		// The hook env carried the requested name and comma-joined labels.
		const envText = readFileSync(envFile, "utf8");
		expect(envText).toContain("name=sandbox-a");
		expect(envText).toContain("labels=env=prod,team=x");
	});

	test("uses the requested name and empty cwd when the hook output omits them", async () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-orch-provision-noname-"));
		const hook = join(dir, "hook.sh");
		writeFileSync(hook, `#!/bin/sh\nprintf '{"url":"ws://127.0.0.1:${hookFake.port}","token":"hook-token"}\\n'\n`);
		chmodSync(hook, 0o755);
		const cfg = join(dir, "config.json");
		writeFileSync(cfg, JSON.stringify({ roots: [], spawnHook: hook }));
		const srv = await startOrchestrator({ port: 0, statePath: join(dir, "state.json"), configPath: cfg });
		try {
			const res = await postJson(srv.port, "/ctl/provision", { name: "requested-name" });
			expect(res.status).toBe(200);
			const body = (await res.json()) as RegistryEntry;
			expect(body.name).toBe("requested-name");
			expect(body.cwd).toBe("");
			expect(body.project).toBe("");
		} finally {
			await srv.close();
		}
	});

	test("502 when the hook exits non-zero; nothing is registered", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, "#!/bin/sh\necho 'provider exploded' >&2\nexit 3\n");
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("spawn hook exited 3");
		expect(body.error).toContain("provider exploded");
		expect(hookServer.registry.list()).toHaveLength(before);
	});

	test("502 when the last stdout line is not valid JSON", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, "#!/bin/sh\necho 'provisioning...'\necho 'not json'\n");
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("not valid JSON");
		expect(hookServer.registry.list()).toHaveLength(before);
	});

	test("502 when the hook output lacks url or token", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, "#!/bin/sh\necho '{\"name\":\"x\"}'\n");
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("missing url or token");
		expect(hookServer.registry.list()).toHaveLength(before);
	});

	test("502 when the hook prints a non-ws url", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, "#!/bin/sh\necho '{\"url\":\"http://example.com\",\"token\":\"t\"}'\n");
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("url must be ws:// or wss://");
		expect(hookServer.registry.list()).toHaveLength(before);
	});

	test("runSpawnHook kills the child and rejects on timeout", async () => {
		// `exec` replaces sh with sleep so the SIGKILL lands on the sleeper.
		await expect(runSpawnHook("exec sleep 120", {}, 200)).rejects.toThrow(/timed out/);
	});

	test("runSpawnHook captures stdout and rejects on non-zero exit", async () => {
		await expect(runSpawnHook("echo 'output'; exit 7", {})).rejects.toThrow(/exited 7/);
	});

	test("CLI provision posts to /ctl/provision and prints the entry", async () => {
		// The 502 tests rewrote the shared hook; restore the happy-path one.
		writeHappyHook();
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		try {
			const code = await main(["provision", "cli-sandbox", "--label", "env=test", "--port", String(hookServer.port)]);
			expect(code).toBe(0);
		} finally {
			console.log = originalLog;
		}
		const output = logs.join("\n");
		expect(output).toContain("provisioned");
		expect(output).toContain("hook-cli-sandbox");
		expect(output).toContain("connecting");
		// The --label flag reached the hook env and the registered entry.
		expect(readFileSync(envFile, "utf8")).toContain("labels=env=test");
		const entry = hookServer.registry.list().find((e) => e.name === "hook-cli-sandbox");
		expect(entry?.labels).toEqual(["env=test"]);
	});
});

describe("CLI", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: OrchestratorServer;
	let seeded: RegistryEntry;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-orch-cli-test-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		const rootsDir = join(tmp, "roots");
		mkdirSync(rootsDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ roots: [rootsDir] }));
		// Seed the registry directly so `daemons` has a row to print.
		const registry = new Registry(statePath);
		await registry.load();
		seeded = registry.create({
			name: "cli-smoke",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: ["env=test"],
			mode: "remote",
			endpoint: "ws://127.0.0.1:1",
			token: "t",
			status: "asleep",
		});
		server = await startOrchestrator({ port: 0, statePath, configPath });
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
	});

	test("main(['daemons']) prints a table via fetch end-to-end", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		try {
			const code = await main(["daemons", "--port", String(server.port)]);
			expect(code).toBe(0);
		} finally {
			console.log = originalLog;
		}
		const output = logs.join("\n");
		expect(output).toContain("id");
		expect(output).toContain(seeded.daemonId);
		expect(output).toContain("cli-smoke");
		expect(output).toContain("env=test");
	});

	test("main with a refused connection exits 1 with the not-running message", async () => {
		// Find a port with no listener: bind and release a server first.
		const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
		const freePort = probe.port;
		probe.stop(true);
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (msg?: unknown) => {
			errors.push(String(msg));
		};
		try {
			const code = await main(["daemons", "--port", String(freePort)]);
			expect(code).toBe(1);
		} finally {
			console.error = originalError;
		}
		expect(errors.join("\n")).toContain("orchestrator not running — start it: omp-orchestrator serve");
	});

	test("CLI serve + daemons end-to-end via Bun.spawn", async () => {
		const serve = Bun.spawn(["bun", "orchestrator/cli.ts", "serve", "--port", "0"], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, OMP_ORCHESTRATOR_STATE: statePath, OMP_ORCHESTRATOR_CONFIG: configPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const port = await readListeningPort(serve.stdout, 10_000);
			expect(port).toBeGreaterThan(0);
			const daemons = Bun.spawn(["bun", "orchestrator/cli.ts", "daemons", "--port", String(port)], {
				cwd: join(import.meta.dir, ".."),
				env: { ...process.env, OMP_ORCHESTRATOR_STATE: statePath, OMP_ORCHESTRATOR_CONFIG: configPath },
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = await readAll(daemons.stdout);
			const errText = await readAll(daemons.stderr);
			const exit = await daemons.exited;
			expect(exit).toBe(0);
			expect(out).toContain(seeded.daemonId);
			expect(out).toContain("cli-smoke");
			expect(errText).toBe("");
		} finally {
			serve.kill("SIGTERM");
			await Promise.race([serve.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
			if (serve.exitCode === null) serve.kill("SIGKILL");
		}
	});
});

/** Read the spawned `serve` stdout until it reports its listening port. */
async function readListeningPort(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<number> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
			const result = (await Promise.race([reader.read(), timer])) as { value?: Uint8Array; done?: boolean } | null;
			if (result === null || result.done) break;
			buffer += decoder.decode(result.value, { stream: true });
			const match = /orchestrator listening on 127\.0\.0\.1:(\d+)/.exec(buffer);
			if (match) return Number(match[1]);
		}
	} finally {
		reader.cancel().catch(() => {});
	}
	throw new Error(`serve did not report a port within ${timeoutMs}ms; stdout so far: ${buffer}`);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
	}
	return buffer;
}
