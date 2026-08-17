/**
 * Control-plane tests for fleet/server.ts: every route exercised over
 * loopback HTTP against a real DaemonConnector + a tiny fake omp-session
 * daemon speaking the OMP_PROTO 2 wire contract (/events SSE + /command
 * POST): the fake primes hello_ok → state → ready on stream open and
 * answers prompt calls with call_result + event frames on the stream. No
 * real omp-session children are spawned.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import {
	OMP_PROTO,
	SSE_DELTA_SEQ_START,
	SSE_EVENT_NAME,
	type RegisteredProject,
} from "../shared/protocol";
import { encodeSseEvent } from "../shared/sse";
import type { RegistryEntry } from "./registry";
import { Registry } from "./registry";
import { runSpawnHook, startFleet, type FleetServer } from "./server";
import { main } from "./cli";

// The /ctl/settings routes lazily initialize the process-global Settings
// singleton on first use; pin it to in-memory so route tests never touch the
// real ~/.omp config.
await Settings.init({ inMemory: true });

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

/** One open /events stream on the fake (these tests open exactly one per daemon — the connector's). */
interface FakeStream {
	write(frame: unknown, seq: number): void;
}

/**
 * Tiny fake omp-session over HTTP: serves /events (SSE) + /command (POST)
 * on a pathless ws:// base (proving daemonHttpBase normalization). Records
 * the Bearer header, primes the status machine on stream open (hello_ok →
 * state → ready — no hello handshake on the wire), and answers prompt
 * calls with call_result + event frames on the stream. `cwd` is the
 * hello_ok.cwd reported to the connector (which rejects mismatches, so
 * spawn tests must point it at the spawned entry's cwd).
 */
function startFakeDaemon(token: string, cwd = FAKE_CWD): FakeDaemon {
	const seen: FakeSeen = { authHeader: null, calls: [], closed: false };
	let stream: FakeStream | null = null;
	const nextSeq = { value: SSE_DELTA_SEQ_START };
	const encoder = new TextEncoder();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/command") {
				return (async () => {
					let msg: unknown;
					try {
						msg = await req.json();
					} catch {
						return new Response("malformed", { status: 400 });
					}
					seen.calls.push(msg);
					const cmd = msg as { type?: string; id?: string; method?: string };
					if (cmd.type === "call" && cmd.method === "prompt" && cmd.id !== undefined && stream) {
						answerTurn(stream, cmd.id, nextSeq);
					}
					return Response.json({ commandId: cmd.id ?? "" }, { status: 202 });
				})();
			}
			if (url.pathname !== "/events") return new Response("not found", { status: 404 });
			seen.authHeader = req.headers.get("authorization");
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					stream = {
						write(frame, seq) {
							controller.enqueue(encoder.encode(encodeSseEvent(SSE_EVENT_NAME, frame, seq)));
						},
					};
					prime(stream, cwd);
				},
				cancel() {
					seen.closed = true;
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		},
	});
	return {
		url: `ws://127.0.0.1:${server.port}`,
		port: server.port!,
		seen,
		close: () => server.stop(true),
	};
}

function prime(stream: FakeStream, cwd: string) {
	stream.write(
		{
			type: "hello_ok",
			proto: OMP_PROTO,
			name: "fake",
			cwd,
			pid: 4242,
			version: "0.0.0-test",
			sessionFile: FAKE_SESSION_FILE,
		},
		1,
	);
	stream.write({ type: "state", sessionId: "s1", state: FAKE_STATE }, 2);
	stream.write({ type: "ready", readyAt: Date.now() }, 3);
}

function answerTurn(stream: FakeStream, callId: string, nextSeq: { value: number }) {
	stream.write({ type: "call_result", id: callId, ok: true }, nextSeq.value++);
	stream.write(
		{
			type: "event",
			sessionId: "s1",
			event: {
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "fake reply" }] },
			},
		},
		nextSeq.value++,
	);
	stream.write(
		{
			type: "event",
			sessionId: "s1",
			event: {
				type: "agent_end",
				messages: [{ role: "assistant", content: [{ type: "text", text: "fake reply" }] }],
			},
		},
		nextSeq.value++,
	);
}

/** Poll until `predicate` is truthy or the timeout elapses. */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
	what = "condition",
): Promise<void> {
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

describe("fleet control plane", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let fake: FakeDaemon;
	let entry: RegistryEntry;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-web-test-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		const rootsDir = join(tmp, "roots");
		mkdirSync(rootsDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ roots: [rootsDir] }));
		server = await startFleet({
			port: 0,
			statePath,
			configPath,
			// Stub the settings provider registry: the default lazily opens
			// the real ~/.omp auth DB, and these tests must not touch it.
			settings: { registry: async () => [] },
		});
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
		if (fake !== undefined) fake.close();
	});

	test("GET /ctl/sessions reflects the registry (empty at boot)", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(0);
	});

	test("GET /ctl/projects returns the discovered scan merged with registered projects", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/projects`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { projects?: unknown; registered?: unknown };
		expect(Array.isArray(body.projects)).toBe(true);
		expect(body.projects).toHaveLength(0);
		expect(Array.isArray(body.registered)).toBe(true);
		expect(body.registered).toHaveLength(0);

		// A registered project (real git repo) appears in `registered`
		// alongside the still-empty ephemeral discovery scan.
		const repoDir = join(tmp, "registered-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const project = await server.registry.addProject(repoDir);
		try {
			const merged = (await (
				await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)
			).json()) as {
				projects: unknown[];
				registered: Array<{ projectId: string }>;
			};
			expect(merged.registered).toHaveLength(1);
			expect(merged.registered[0].projectId).toBe(project.projectId);
		} finally {
			server.registry.removeProject(project.projectId);
		}
	});

	test("POST /ctl/projects registers a git repo and returns 201 with the project", async () => {
		const repoDir = join(tmp, "ctl-add-project-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const res = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			project?: { projectId?: string; path?: string; name?: string; addedAt?: number };
			entry?: unknown;
		};
		expect(body.project?.projectId).toMatch(/^p\d+$/);
		expect(body.project?.path).toBe(realpathSync(repoDir));
		expect(body.project?.name).toBe(basename(repoDir));
		expect(typeof body.project?.addedAt).toBe("number");
		expect(body.entry).toBeUndefined();
		// The registered project shows up in GET /ctl/projects.
		const merged = (await (await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)).json()) as {
			registered: Array<{ projectId: string }>;
		};
		expect(merged.registered.some((p) => p.projectId === body.project!.projectId)).toBe(true);
		// Cleanup: the project has no daemons, so removal succeeds.
		const del = await fetch(
			`http://127.0.0.1:${server.port}/ctl/projects/${body.project!.projectId}`,
			{ method: "DELETE" },
		);
		expect(del.status).toBe(200);
	});

	test("POST /ctl/projects dedupes an already-registered realpath to 409 with the existing project", async () => {
		const repoDir = join(tmp, "ctl-dedup-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const first = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(first.status).toBe(201);
		const firstBody = (await first.json()) as { project: { projectId: string } };
		try {
			// Same realpath again (also via a trailing-slash variant): dedup → 409 + project.
			const dup = await postJson(server.port, "/ctl/projects", { path: repoDir });
			expect(dup.status).toBe(409);
			const dupBody = (await dup.json()) as { error?: string; project?: { projectId?: string } };
			expect(dupBody.error).toContain("already registered");
			expect(dupBody.error).toContain(firstBody.project.projectId);
			expect(dupBody.project?.projectId).toBe(firstBody.project.projectId);
			// One registration only.
			expect(
				server.registry.projects().filter((p) => p.path === realpathSync(repoDir)),
			).toHaveLength(1);
		} finally {
			server.registry.removeProject(firstBody.project.projectId);
		}
	});

	test("POST /ctl/projects 400s when the path is not a git repo", async () => {
		const plainDir = join(tmp, "ctl-not-a-repo");
		mkdirSync(plainDir, { recursive: true });
		const res = await postJson(server.port, "/ctl/projects", { path: plainDir });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("not a git repository");
	});

	test("DELETE /ctl/projects/:id 409s naming daemons that still reference the project", async () => {
		const repoDir = join(tmp, "ctl-blocked-repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		const res = await postJson(server.port, "/ctl/projects", { path: repoDir });
		expect(res.status).toBe(201);
		const body = (await res.json()) as { project: { projectId: string } };
		// A daemon referencing the project blocks removal (no cascade).
		const ref = server.registry.create({
			name: "ref",
			cwd: realpathSync(repoDir),
			project: basename(repoDir),
			labels: [],
			mode: "spawned",
			template: "test",
			status: "asleep",
			projectId: body.project.projectId,
		});
		try {
			const del = await fetch(
				`http://127.0.0.1:${server.port}/ctl/projects/${body.project.projectId}`,
				{ method: "DELETE" },
			);
			expect(del.status).toBe(409);
			const delBody = (await del.json()) as { error?: string };
			expect(delBody.error).toContain("in use by daemons");
			expect(delBody.error).toContain(ref.daemonId);
			expect(server.registry.projects().some((p) => p.projectId === body.project.projectId)).toBe(
				true,
			);
			// Once the daemon is gone, removal succeeds.
			server.registry.remove(ref.daemonId);
			const ok = await fetch(
				`http://127.0.0.1:${server.port}/ctl/projects/${body.project.projectId}`,
				{ method: "DELETE" },
			);
			expect(ok.status).toBe(200);
			const okBody = (await ok.json()) as { removed?: unknown };
			expect(okBody.removed).toBe(body.project.projectId);
			expect(server.registry.projects().some((p) => p.projectId === body.project.projectId)).toBe(
				false,
			);
		} finally {
			server.registry.remove(ref.daemonId);
			try {
				server.registry.removeProject(body.project.projectId);
			} catch {
				// Already removed by the happy path above.
			}
		}
	});

	test("DELETE /ctl/projects/:id 404s for an unknown project id", async () => {
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/projects/p999`, {
			method: "DELETE",
		});
		expect(del.status).toBe(404);
		const body = (await del.json()) as { error?: string };
		expect(body.error).toContain("unknown project id");
	});

	test("GET /ctl/settings returns the unattached settings model", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/settings`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tabs?: Array<{ id: string; label: string; groups: Array<{ items: unknown[] }> }>;
		};
		expect(Array.isArray(body.tabs)).toBe(true);
		expect((body.tabs ?? []).length).toBeGreaterThan(0);
		for (const tab of body.tabs ?? []) {
			expect(tab.label.length).toBeGreaterThan(0);
			expect(tab.groups.length).toBeGreaterThan(0);
		}
	});

	test("POST /ctl/settings/set persists a coerced value and returns a fresh model", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "50",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			tabs: Array<{
				id: string;
				groups: Array<{ items: Array<{ path: string; value: unknown; changed: boolean }> }>;
			}>;
		};
		const item = body.tabs
			.find((tab) => tab.id === "context")
			?.groups.flatMap((group) => group.items)
			.find((item) => item.path === "compaction.thresholdPercent");
		expect(item?.value).toBe(50);
		expect(item?.changed).toBe(true);
		// Restore the schema default so the shared in-memory singleton stays
		// pristine for the rest of the file.
		await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "default",
		});
	});

	test("POST /ctl/settings/set 400s on an unknown path", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "no.such.path",
			value: 1,
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("Unknown setting");
	});

	test("POST /ctl/settings/set 400s on an uncoercible value", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", {
			path: "compaction.thresholdPercent",
			value: "abc",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("Invalid numeric value");
	});

	test("POST /ctl/settings/set 400s when path is missing", async () => {
		const res = await postJson(server.port, "/ctl/settings/set", { value: 1 });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("missing or invalid field: path");
	});

	test("POST /ctl/spawn 400s on a nonexistent path", async () => {
		const res = await postJson(server.port, "/ctl/spawn", { cwd: join(tmp, "does-not-exist") });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("POST /ctl/spawn 400s when name/labels contain NUL", async () => {
		const cwd = join(tmp, "roots");
		const resName = await postJson(server.port, "/ctl/spawn", { cwd, name: "a\u0000b" });
		expect(resName.status).toBe(400);
		const bodyName = (await resName.json()) as { error?: string };
		expect(bodyName.error).toContain("NUL");
		const resLabels = await postJson(server.port, "/ctl/spawn", {
			cwd,
			labels: ["k=v", "x\u0000y"],
		});
		expect(resLabels.status).toBe(400);
		const bodyLabels = (await resLabels.json()) as { error?: string };
		expect(bodyLabels.error).toContain("NUL");
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
		const res = await postJson(server.port, "/ctl/add", {
			name: "added",
			url: fake.url,
			token: "sekret",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry;
		expect(body.mode).toBe("remote");
		expect(body.status).toBe("connecting");
		entry = body;
		// The connector must dial the fake and present the Bearer header.
		await waitFor(() => fake.seen.authHeader !== null, 5000, "fake daemon dial");
		expect(fake.seen.authHeader).toBe("Bearer sekret");
		// hello_ok.cwd is adopted when the entry had no cwd.
		await waitFor(
			() => server.registry.get(entry.daemonId)?.status === "ready",
			5000,
			"daemon ready",
		);
		expect(server.registry.get(entry.daemonId)?.cwd).toBe(FAKE_CWD);
	});

	test("sessions list reflects the registry after add", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/sessions`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as RegistryEntry[];
		const found = body.find((e) => e.daemonId === entry.daemonId);
		expect(found).toBeDefined();
		expect(found?.name).toBe("added");
		expect(found?.status).toBe("ready");
		expect(found?.endpoint).toBe(fake.url);
	});

	test("GET /ctl/debug returns fleet facts, per-session internals, and the event log — never tokens", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/debug`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		// Fleet facts block.
		const fleet = body.fleet as {
			port?: number;
			startedAt?: number;
			uptimeSec?: number;
			statePath?: string;
			configPath?: unknown;
		};
		expect(fleet.port).toBe(server.port);
		expect(typeof fleet.startedAt).toBe("number");
		expect(fleet.uptimeSec).toBeGreaterThanOrEqual(0);
		expect(fleet.statePath).toBe(statePath);
		expect(fleet.configPath).toBe(configPath);
		// Sessions carry the live entry plus connector/supervisor internals.
		const sessions = body.sessions as Array<Record<string, unknown>>;
		expect(Array.isArray(sessions)).toBe(true);
		const found = sessions.find((session) => session.daemonId === entry.daemonId);
		expect(found).toBeDefined();
		expect(found?.status).toBe("ready");
		expect(found?.endpoint).toBe(fake.url);
		expect(found?.registeredAt).toBe(server.registry.get(entry.daemonId)?.registeredAt);
		expect(found?.uptimeSec).toBeGreaterThanOrEqual(0);
		expect(found?.connector).toMatchObject({ state: "streaming", attempts: 0 });
		// The log holds the lifecycle trail for this daemon (its status
		// transitions landed in the ring at the connector wiring points).
		const log = body.log as Array<{
			source?: string;
			daemonId?: string;
			level?: string;
			message?: string;
		}>;
		expect(Array.isArray(log)).toBe(true);
		expect(log.length).toBeGreaterThan(0);
		expect(
			log.some((event) => event.source === "connector" && event.daemonId === entry.daemonId),
		).toBe(true);
		expect(
			log.some(
				(event) => event.source === "server" && event.message === `added added (${fake.url})`,
			),
		).toBe(true);
		// The browser-facing payload must never leak a bearer token: no key
		// named "token" anywhere in the JSON tree.
		const scan = (value: unknown): void => {
			if (Array.isArray(value)) return value.forEach(scan);
			if (typeof value === "object" && value !== null) {
				for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
					expect(key).not.toBe("token");
					scan(val);
				}
			}
		};
		scan(body);
	});

	test("POST /ctl/prompt with an unknown selector 404s", async () => {
		const res = await postJson(server.port, "/ctl/prompt", { selector: "d999", text: "hi" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/prompt without waitMs returns { submitted } and dispatches", async () => {
		const res = await postJson(server.port, "/ctl/prompt", {
			selector: entry.daemonId,
			text: "ping",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { submitted?: unknown };
		expect(body.submitted).toEqual([entry.daemonId]);
		// The background dispatch must reach the fake (prompt call observed).
		await waitFor(
			() =>
				fake.seen.calls.some(
					(c) =>
						(c as { type?: string; method?: string }).type === "call" &&
						(c as { method?: string }).method === "prompt",
				),
			5000,
			"prompt call on fake",
		);
	});

	test("POST /ctl/prompt with waitMs returns PromptResult[]", async () => {
		const res = await postJson(server.port, "/ctl/prompt", {
			selector: entry.daemonId,
			text: "hello there",
			waitMs: 5000,
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			daemonId?: string;
			ok?: boolean;
			text?: string;
			error?: string;
		}>;
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

	test("POST /ctl/remove 404s on an unknown selector", async () => {
		const res = await postJson(server.port, "/ctl/remove", { selector: "nope" });
		expect(res.status).toBe(404);
	});

	test("POST /ctl/remove evicts a remote entry from the registry", async () => {
		// Its own fake daemon + fresh entry, so the shared `entry` fixture
		// (and the shared `fake`) stays intact for later tests.
		const localFake = startFakeDaemon("remove-token");
		try {
			const res = await postJson(server.port, "/ctl/add", {
				name: "removable",
				url: localFake.url,
				token: "remove-token",
			});
			expect(res.status).toBe(200);
			const added = (await res.json()) as RegistryEntry;
			await waitFor(
				() => server.registry.get(added.daemonId)?.status === "ready",
				5000,
				"removable daemon ready",
			);
			// #24: the connector tracks per-daemon state for the dialed entry;
			// removal must prune it, not leave listeners/waiters/retain counts
			// behind a gone registry entry.
			const before = server.connector.stateCount();
			expect(before).toBeGreaterThan(0);
			const del = await postJson(server.port, "/ctl/remove", { selector: added.daemonId });
			expect(del.status).toBe(200);
			const body = (await del.json()) as { removed?: unknown };
			expect(body.removed).toEqual([added.daemonId]);
			expect(server.registry.get(added.daemonId)).toBeUndefined();
			expect(server.connector.stateCount()).toBe(before - 1);
			expect(server.connector.isConnected(added.daemonId)).toBe(false);
		} finally {
			localFake.close();
		}
	});

	test("unknown route 404s", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/nope`);
		expect(res.status).toBe(404);
	});
});

describe("POST /ctl/projects with start:true (Phase 3 spawn)", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let fake: FakeDaemon;
	let repoReal: string;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-web-add-repo-spawn-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		// The spawn fixture: the fake omp-session reports the spawned cwd in
		// hello_ok (the connector rejects a mismatch), so the fake starts
		// with the repo's realpath before registration — the template's
		// listening line points at it.
		const repoDir = join(tmp, "repo");
		mkdirSync(repoDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], { cwd: repoDir, stdout: "pipe", stderr: "pipe" });
		expect(await proc.exited).toBe(0);
		repoReal = realpathSync(repoDir);
		fake = startFakeDaemon("spawn-token", repoReal);
		writeFileSync(
			configPath,
			JSON.stringify({
				roots: [],
				templates: {
					test: {
						command: `printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${fake.port},"url":"ws://127.0.0.1:${fake.port}"}' && while :; do sleep 0.05; done`,
					},
				},
				defaultTemplate: "test",
			}),
		);
		server = await startFleet({
			port: 0,
			statePath,
			configPath,
			settings: { registry: async () => [] },
		});
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
		if (fake !== undefined) fake.close();
	});

	test("start:true spawns on the project path, tags the entry's projectId, and reaches ready", async () => {
		const repoDir = join(tmp, "repo");
		const res = await postJson(server.port, "/ctl/projects", {
			path: repoDir,
			start: true,
			template: "test",
			labels: ["env=prod"],
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as {
			project: { projectId: string; path: string };
			entry: RegistryEntry;
		};
		expect(body.project.path).toBe(repoReal);
		expect(body.entry.mode).toBe("spawned");
		expect(body.entry.cwd).toBe(repoReal);
		expect(body.entry.projectId).toBe(body.project.projectId);
		expect(body.entry.labels).toEqual(["env=prod"]);
		// The supervisor's spawn dialed the fake: the connector reaches ready.
		await waitFor(
			() => server.registry.get(body.entry.daemonId)?.status === "ready",
			5000,
			"spawned entry ready",
		);
		expect(server.registry.get(body.entry.daemonId)?.projectId).toBe(body.project.projectId);
	});

	test("start:true with an unknown template 500s but the project stays registered", async () => {
		const otherDir = join(tmp, "other-repo");
		mkdirSync(otherDir, { recursive: true });
		const proc = Bun.spawn(["git", "init", "-q"], {
			cwd: otherDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(0);
		const before = server.registry.projects().length;
		const res = await postJson(server.port, "/ctl/projects", {
			path: otherDir,
			start: true,
			template: "no-such-template",
		});
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("spawn failed");
		// The project stays registered (staged: registration happens first).
		expect(server.registry.projects().some((p) => p.path === realpathSync(otherDir))).toBe(true);
		expect(server.registry.projects().length).toBe(before + 1);
		// No daemon entry was created for the failed spawn.
		const project = server.registry.projects().find((p) => p.path === realpathSync(otherDir));
		expect(server.registry.list().some((e) => e.projectId === project?.projectId)).toBe(false);
	});
});

describe("boot reconciliation (#3)", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let server: FleetServer;
	let fake: FakeDaemon;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-web-boot-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		writeFileSync(configPath, JSON.stringify({ roots: [] }));
		fake = startFakeDaemon("boot-token");
		// Seed the registry exactly as a previous fleet process would have
		// left it: stale non-terminal statuses (children/sockets died with
		// that process), an intentional stop, and a real error.
		const registry = new Registry(statePath);
		await registry.load();
		registry.create({
			name: "stale-ready",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "test",
			status: "ready",
			readyAt: Date.now() - 60_000,
			pid: 12345,
		});
		registry.create({
			name: "stuck-spawning",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "test",
			status: "spawning",
		});
		registry.create({
			name: "stale-connecting",
			cwd: FAKE_CWD,
			project: "fake-proj",
			labels: [],
			mode: "spawned",
			template: "test",
			status: "connecting",
		});
		registry.create({
			name: "boot-dial",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			endpoint: fake.url,
			token: "boot-token",
			status: "ready",
			readyAt: Date.now() - 120_000,
		});
		registry.create({
			name: "stopped",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			endpoint: "ws://127.0.0.1:1",
			status: "asleep",
		});
		registry.create({
			name: "terminal-error",
			cwd: "",
			project: "",
			labels: [],
			mode: "remote",
			endpoint: "ws://127.0.0.1:1",
			status: "error",
			error: "unauthorized (401): daemon rejected the token",
		});
		server = await startFleet({ port: 0, statePath, configPath });
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
		if (fake !== undefined) fake.close();
	});

	test("spawned stale 'ready'/'spawning'/'connecting' entries are downgraded to asleep with stale readyAt/pid cleared", () => {
		const entries = server.registry.list();
		const staleReady = entries.find((e) => e.name === "stale-ready")!;
		expect(staleReady.status).toBe("asleep");
		expect(staleReady.readyAt).toBeUndefined();
		expect(staleReady.pid).toBeUndefined();
		expect(entries.find((e) => e.name === "stuck-spawning")!.status).toBe("asleep");
		expect(entries.find((e) => e.name === "stale-connecting")!.status).toBe("asleep");
	});

	test("a remote entry persisted 'ready' is redialed at boot (connecting → ready via the connector)", async () => {
		const entry = server.registry.list().find((e) => e.name === "boot-dial")!;
		// The boot reconcile dials immediately; the fake must see the token.
		await waitFor(() => fake.seen.authHeader !== null, 5000, "boot dial");
		expect(fake.seen.authHeader).toBe("Bearer boot-token");
		await waitFor(
			() => server.registry.get(entry.daemonId)?.status === "ready",
			5000,
			"re-ready after boot redial",
		);
		expect(server.registry.get(entry.daemonId)?.readyAt).toBeTypeOf("number");
	});

	test("intentionally stopped and terminal-error entries are left untouched", async () => {
		const stopped = server.registry.list().find((e) => e.name === "stopped")!;
		const errored = server.registry.list().find((e) => e.name === "terminal-error")!;
		expect(stopped.status).toBe("asleep");
		expect(errored.status).toBe("error");
		expect(errored.error).toContain("unauthorized");
		// A short wait proves the stopped entry was NOT dialed: the connector
		// transitions synchronously on connect(), so any dial would have left
		// "asleep" by now.
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(server.registry.get(stopped.daemonId)?.status).toBe("asleep");
		expect(server.connector.isConnected(stopped.daemonId)).toBe(false);
	});
});

describe("POST /ctl/provision (spawn hook)", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let hookPath: string;
	let envFile: string;
	let hookServer: FleetServer;
	let hookFake: FakeDaemon;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-web-provision-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		envFile = join(tmp, "hook-env.txt");
		hookFake = startFakeDaemon("hook-token");
		hookPath = join(tmp, "hook.sh");
		writeHappyHook();
		// `sh -c <path>` needs the exec bit; rewrites below keep the mode.
		chmodSync(hookPath, 0o755);
		writeFileSync(configPath, JSON.stringify({ roots: [], spawnHook: hookPath }));
		hookServer = await startFleet({ port: 0, statePath, configPath });
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
		const res = await postJson(hookServer.port, "/ctl/provision", {
			name: "sandbox-a",
			labels: ["env=prod", "team=x"],
		});
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
		const dir = mkdtempSync(join(tmpdir(), "omp-web-provision-noname-"));
		const hook = join(dir, "hook.sh");
		writeFileSync(
			hook,
			`#!/bin/sh\nprintf '{"url":"ws://127.0.0.1:${hookFake.port}","token":"hook-token"}\\n'\n`,
		);
		chmodSync(hook, 0o755);
		const cfg = join(dir, "config.json");
		writeFileSync(cfg, JSON.stringify({ roots: [], spawnHook: hook }));
		const srv = await startFleet({ port: 0, statePath: join(dir, "state.json"), configPath: cfg });
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
		writeFileSync(hookPath, '#!/bin/sh\necho \'{"name":"x"}\'\n');
		const res = await postJson(hookServer.port, "/ctl/provision", { name: "x" });
		expect(res.status).toBe(502);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("missing url or token");
		expect(hookServer.registry.list()).toHaveLength(before);
	});

	test("502 when the hook prints a non-ws url", async () => {
		const before = hookServer.registry.list().length;
		writeFileSync(hookPath, '#!/bin/sh\necho \'{"url":"http://example.com","token":"t"}\'\n');
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
			const code = await main([
				"provision",
				"cli-sandbox",
				"--label",
				"env=test",
				"--port",
				String(hookServer.port),
			]);
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
	let server: FleetServer;
	let seeded: RegistryEntry;

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-web-cli-test-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		const rootsDir = join(tmp, "roots");
		mkdirSync(rootsDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ roots: [rootsDir] }));
		// Seed the registry directly so `sessions` has a row to print.
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
		server = await startFleet({ port: 0, statePath, configPath });
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
	});

	test("main(['sessions']) prints a table via fetch end-to-end", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		try {
			const code = await main(["sessions", "--port", String(server.port)]);
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
			const code = await main(["sessions", "--port", String(freePort)]);
			expect(code).toBe(1);
		} finally {
			console.error = originalError;
		}
		expect(errors.join("\n")).toContain("fleet not running — start it: omp-web serve");
	});

	test("usage no longer advertises the removed --fan-out flag (audit #26)", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		try {
			const code = await main(["help"]);
			expect(code).toBe(0);
		} finally {
			console.log = originalLog;
		}
		const output = logs.join("\n");
		expect(output).not.toContain("--fan-out");
		expect(output).toContain("prompt <selector> <text> [--wait <ms>]");
	});

	test("a flag value starting with '-' errors instead of being silently dropped (audit #26)", async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (msg?: unknown) => {
			errors.push(String(msg));
		};
		try {
			// --wait -1 previously parsed as boolean true (value "dropped" and
			// "-1" leaked into the prompt text); now it is a parse error.
			const code = await main(["prompt", "x", "hi", "--wait", "-1"]);
			expect(code).toBe(1);
		} finally {
			console.error = originalError;
		}
		expect(errors.join("\n")).toContain("invalid value for --wait: -1");
	});

	test("a flag with no value at the end of argv errors (audit #26)", async () => {
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (msg?: unknown) => {
			errors.push(String(msg));
		};
		try {
			const code = await main(["sessions", "--port"]);
			expect(code).toBe(1);
		} finally {
			console.error = originalError;
		}
		expect(errors.join("\n")).toContain("missing value for --port");
	});

	test("CLI serve + sessions end-to-end via Bun.spawn", async () => {
		const serve = Bun.spawn(["bun", "fleet/cli.ts", "serve", "--port", "0"], {
			cwd: join(import.meta.dir, ".."),
			env: { ...process.env, OMP_FLEET_STATE: statePath, OMP_FLEET_CONFIG: configPath },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			const port = await readListeningPort(serve.stdout, 10_000);
			expect(port).toBeGreaterThan(0);
			const sessions = Bun.spawn(["bun", "fleet/cli.ts", "sessions", "--port", String(port)], {
				cwd: join(import.meta.dir, ".."),
				env: { ...process.env, OMP_FLEET_STATE: statePath, OMP_FLEET_CONFIG: configPath },
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = await readAll(sessions.stdout);
			const errText = await readAll(sessions.stderr);
			const exit = await sessions.exited;
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
async function readListeningPort(
	stream: ReadableStream<Uint8Array>,
	timeoutMs: number,
): Promise<number> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	try {
		while (Date.now() < deadline) {
			const remaining = deadline - Date.now();
			const timer = new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining));
			const result = (await Promise.race([reader.read(), timer])) as {
				value?: Uint8Array;
				done?: boolean;
			} | null;
			if (result === null || result.done) break;
			buffer += decoder.decode(result.value, { stream: true });
			const match = /fleet listening on 127\.0\.0\.1:(\d+)/.exec(buffer);
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

describe("worktree lifecycle routes", () => {
	let tmp: string;
	let statePath: string;
	let configPath: string;
	let workspaceDir: string;
	let repoDir: string;
	let server: FleetServer;
	let project: RegisteredProject;

	/** One `git -C <cwd> <args>` invocation against the real local repo. */
	async function gitIn(
		cwd: string,
		args: string[],
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr] = await Promise.all([
			Bun.readableStreamToText(proc.stdout),
			Bun.readableStreamToText(proc.stderr),
		]);
		return { exitCode: await proc.exited, stdout, stderr };
	}

	beforeAll(async () => {
		tmp = mkdtempSync(join(tmpdir(), "omp-web-wt-routes-"));
		statePath = join(tmp, "state.json");
		configPath = join(tmp, "config.json");
		workspaceDir = join(tmp, "workspaces");
		// A real git repo (main checkout) to register.
		repoDir = join(tmp, "repo");
		mkdirSync(repoDir, { recursive: true });
		const init = Bun.spawn(["git", "init", "-q", "-b", "main"], {
			cwd: repoDir,
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await init.exited).toBe(0);
		await gitIn(repoDir, ["config", "user.email", "test@example.com"]);
		await gitIn(repoDir, ["config", "user.name", "Test"]);
		writeFileSync(join(repoDir, "readme.md"), "hello\n");
		await gitIn(repoDir, ["add", "."]);
		await gitIn(repoDir, ["commit", "-q", "-m", "init"]);
		// The "local" template idles so a start:true spawn never reaches a
		// real omp-session; the route tests stop the child themselves.
		writeFileSync(
			configPath,
			JSON.stringify({
				roots: [],
				templates: { local: { command: "sleep 30" } },
				defaultTemplate: "local",
			}),
		);
		server = await startFleet({ port: 0, statePath, configPath, workspaceDir });
		project = await server.registry.addProject(repoDir);
	});

	afterAll(async () => {
		if (server !== undefined) await server.close();
	});

	test("POST /ctl/projects/:id/worktrees creates a managed worktree and registers the entry (start:false)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Feature Branch",
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry?: RegistryEntry };
		const entry = body.entry!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.mode).toBe("spawned");
		expect(entry.status).toBe("asleep");
		const target = join(workspaceDir, project.name, "feature-branch");
		expect(entry.cwd).toBe(target);
		expect(existsSync(target)).toBe(true);
		// Ownership marker records the owning repo realpath.
		expect(readFileSync(join(workspaceDir, project.name, ".ompweb-repo"), "utf8").trim()).toBe(
			repoDir,
		);
		// git agrees: the worktree is listed with the slug branch.
		const list = await gitIn(repoDir, ["worktree", "list", "--porcelain"]);
		expect(list.stdout).toContain(target);
		expect(list.stdout).toContain("branch refs/heads/feature-branch");
	});

	test("POST create with start:true also spawns a daemon on the worktree", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Started",
			start: true,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry?: RegistryEntry };
		const entry = body.entry!;
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.mode).toBe("spawned");
		const target = join(workspaceDir, project.name, "started");
		expect(entry.cwd).toBe(target);
		expect(existsSync(target)).toBe(true);
		// The spawned child idles (`sleep 30`); stop it so the suite ends clean.
		await server.supervisor.stop(entry.daemonId);
	});

	test("POST add-existing registers a discovered-but-unregistered worktree (start:false)", async () => {
		// A linked worktree created out-of-band with raw git — exactly what
		// discovery's Add-existing tab would list.
		const outside = join(tmp, "raw-worktree");
		const add = await gitIn(repoDir, ["worktree", "add", "-b", "raw-feat", outside]);
		expect(add.exitCode).toBe(0);
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			worktreePath: outside,
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { entry?: RegistryEntry };
		const entry = body.entry!;
		expect(entry.cwd).toBe(outside);
		expect(entry.projectId).toBe(project.projectId);
		expect(entry.worktreeOf).toBe(project.name);
		expect(entry.mode).toBe("spawned");
		expect(entry.status).toBe("asleep");
	});

	test("POST add-existing refuses the main checkout and non-worktree paths", async () => {
		const main = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			worktreePath: repoDir,
		});
		expect(main.status).toBe(400);
		const mainBody = (await main.json()) as { error?: string };
		expect(mainBody.error).toContain("not a linked worktree");
		const notRepo = join(tmp, "not-a-repo");
		mkdirSync(notRepo, { recursive: true });
		const plain = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			worktreePath: notRepo,
		});
		expect(plain.status).toBe(400);
	});

	test("POST add-existing refuses an already-registered worktree (409)", async () => {
		const outside = join(tmp, "raw-worktree");
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			worktreePath: outside,
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain("already registered");
	});

	test("POST create 404s on an unknown project and 409s on a duplicate target", async () => {
		const unknown = await postJson(server.port, "/ctl/projects/p999/worktrees", { name: "x" });
		expect(unknown.status).toBe(404);
		const dup = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Feature Branch",
		});
		expect(dup.status).toBe(409);
		const dupBody = (await dup.json()) as { error?: string };
		expect(dupBody.error).toContain("create worktree failed");
	});

	test("GET /ctl/worktrees/:id/delete-info returns guard evidence (never deletes)", async () => {
		const target = join(workspaceDir, project.name, "feature-branch");
		const entry = server.registry.list().find((e) => e.cwd === target)!;
		const res = await fetch(
			`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}/delete-info`,
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			daemonId?: string;
			owned?: boolean;
			dirty?: boolean;
			branch?: string;
			merged?: boolean;
			unpushed?: boolean;
		};
		expect(body.daemonId).toBe(entry.daemonId);
		expect(body.owned).toBe(true);
		expect(body.dirty).toBe(false);
		expect(body.branch).toBe("feature-branch");
		expect(body.merged).toBe(true);
		expect(body.unpushed).toBe(false);
		// Unknown daemons 404.
		const missing = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/d999/delete-info`);
		expect(missing.status).toBe(404);
	});

	test("DELETE /ctl/worktrees/:id stops, evicts, and git-removes the worktree", async () => {
		const target = join(workspaceDir, project.name, "feature-branch");
		const entry = server.registry.list().find((e) => e.cwd === target)!;
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			removed?: string;
			worktree?: { path?: string; branch?: string };
		};
		expect(body.removed).toBe(entry.daemonId);
		expect(body.worktree?.path).toBe(target);
		expect(server.registry.get(entry.daemonId)).toBeUndefined();
		expect(existsSync(target)).toBe(false);
		expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).not.toContain(
			target,
		);
	});

	test("DELETE refuses a dirty worktree with 409, leaving entry and dir intact", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Dirty",
		});
		expect(res.status).toBe(201);
		const entry = ((await res.json()) as { entry: RegistryEntry }).entry;
		const target = entry.cwd;
		writeFileSync(join(target, "scratch.txt"), "x\n");
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(del.status).toBe(409);
		const delBody = (await del.json()) as { error?: string };
		expect(delBody.error).toContain("uncommitted changes");
		// The refusal mutated nothing.
		expect(server.registry.get(entry.daemonId)).toBeDefined();
		expect(existsSync(target)).toBe(true);
		expect((await gitIn(repoDir, ["worktree", "list", "--porcelain"])).stdout).toContain(target);
	});

	test("DELETE refuses a not-owned cwd with 403", async () => {
		const rogue = server.registry.create({
			name: "rogue",
			cwd: join(tmp, "outside-rogue"),
			project: "x",
			labels: [],
			mode: "spawned",
			status: "asleep",
		});
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${rogue.daemonId}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(403);
		expect(server.registry.get(rogue.daemonId)).toBeDefined();
		server.registry.remove(rogue.daemonId);
	});

	test("DELETE with deleteBranch:true also removes the merged branch (-d only)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Branchy",
		});
		expect(res.status).toBe(201);
		const entry = ((await res.json()) as { entry: RegistryEntry }).entry;
		const del = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/${entry.daemonId}`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deleteBranch: true }),
		});
		expect(del.status).toBe(200);
		const delBody = (await del.json()) as {
			worktree?: { branch?: string; branchDeleted?: boolean };
		};
		expect(delBody.worktree?.branch).toBe("branchy");
		expect(delBody.worktree?.branchDeleted).toBe(true);
		expect((await gitIn(repoDir, ["branch", "--list", "branchy"])).stdout.trim()).toBe("");
	});

	test("DELETE on an unknown daemon 404s", async () => {
		const res = await fetch(`http://127.0.0.1:${server.port}/ctl/worktrees/d999`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
	});

	test("CLI add-worktree creates via the route (selector by name, --no-start respected)", async () => {
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		let code: number;
		try {
			code = await main([
				"add-worktree",
				project.name,
				"Cli Branch",
				"--no-start",
				"--port",
				String(server.port),
			]);
		} finally {
			console.log = originalLog;
		}
		expect(code).toBe(0);
		const output = logs.join("\n");
		expect(output).toContain("created worktree");
		expect(output).toContain("cli-branch");
		expect(output).toContain("not started");
		expect(existsSync(join(workspaceDir, project.name, "cli-branch"))).toBe(true);
	});

	test("CLI add-worktree --existing registers a discovered worktree", async () => {
		const outside = join(tmp, "cli-existing");
		await gitIn(repoDir, ["worktree", "add", "-b", "cli-feat", outside]);
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		let code: number;
		try {
			code = await main([
				"add-worktree",
				project.projectId,
				"--existing",
				outside,
				"--no-start",
				"--port",
				String(server.port),
			]);
		} finally {
			console.log = originalLog;
		}
		expect(code).toBe(0);
		expect(logs.join("\n")).toContain("registered worktree");
		expect(
			server.registry.list().some((e) => e.cwd === outside && e.projectId === project.projectId),
		).toBe(true);
	});

	test("CLI rm-worktree deletes via the route (--delete-branch removes the merged branch)", async () => {
		const res = await postJson(server.port, `/ctl/projects/${project.projectId}/worktrees`, {
			name: "Rm Me",
			start: false,
		});
		expect(res.status).toBe(201);
		const entry = ((await res.json()) as { entry: RegistryEntry }).entry;
		const target = entry.cwd;
		const logs: string[] = [];
		const originalLog = console.log;
		console.log = (msg?: unknown) => {
			logs.push(String(msg));
		};
		let code: number;
		try {
			code = await main([
				"rm-worktree",
				entry.daemonId,
				"--delete-branch",
				"--port",
				String(server.port),
			]);
		} finally {
			console.log = originalLog;
		}
		expect(code).toBe(0);
		expect(logs.join("\n")).toContain("removed worktree daemon");
		expect(server.registry.get(entry.daemonId)).toBeUndefined();
		expect(existsSync(target)).toBe(false);
		// The merged branch was `git branch -d`-ed (never -D).
		expect((await gitIn(repoDir, ["branch", "--list", "rm-me"])).stdout.trim()).toBe("");
	});

	test("GET /ctl/projects merges a registered project's unregistered linked worktrees and drops roster cwds", async () => {
		// A linked worktree OUTSIDE the discovery roots (roots are [] here):
		// only the registry-backed merge can surface it.
		const wtPath = join(tmp, "ctl-merge-wt");
		const add = await gitIn(repoDir, ["worktree", "add", "-q", "-b", "merge-feat", wtPath]);
		expect(add.exitCode).toBe(0);
		const wtReal = realpathSync(wtPath);
		let entry: RegistryEntry | undefined;
		try {
			const merged = (await (
				await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)
			).json()) as {
				projects: Array<{
					name: string;
					path: string;
					isWorktree: boolean;
					worktreeOf?: string;
					branch?: string;
				}>;
			};
			expect(merged.projects).toContainEqual({
				name: "ctl-merge-wt",
				path: wtReal,
				isWorktree: true,
				worktreeOf: project.name,
				branch: "merge-feat",
			});

			// A roster entry for that cwd marks it managed → the row
			// disappears from the projects array.
			entry = server.registry.create({
				name: "ctl-merge-wt",
				cwd: wtReal,
				project: "ctl-merge-wt",
				projectId: project.projectId,
				worktreeOf: project.name,
				labels: [],
				mode: "spawned",
				status: "asleep",
			});
			const merged2 = (await (
				await fetch(`http://127.0.0.1:${server.port}/ctl/projects`)
			).json()) as {
				projects: Array<{ path: string }>;
			};
			expect(merged2.projects.some((p) => p.path === wtReal)).toBe(false);
		} finally {
			if (entry) server.registry.remove(entry.daemonId);
			await gitIn(repoDir, ["worktree", "remove", "--force", wtReal]);
		}
	});
});
