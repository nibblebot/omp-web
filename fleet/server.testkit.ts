/**
 * Shared fixtures/helpers for the fleet/server split test files (*.test.ts).
 * NOT a test file: bun test discovery (`.test.`/`_test.`/`.spec.`/`_spec.`
 * patterns) never matches `*.testkit.ts`, so this never runs as a suite.
 *
 * Everything here exercises loopback HTTP against a real DaemonConnector +
 * a tiny fake omp-session daemon speaking the OMP_PROTO 2 wire contract
 * (/events SSE + /command POST): the fake primes hello_ok → state → ready on
 * stream open and answers prompt calls with call_result + event frames on
 * the stream. No real omp-session children are spawned.
 */

import { expect } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent";
import { OMP_PROTO, SSE_DELTA_SEQ_START, SSE_EVENT_NAME } from "../shared/protocol";
import { encodeSseEvent } from "../shared/sse";
import { cleanupTempDirs, tempDir } from "../shared/testkit";
import { startFleet, type FleetServer } from "./server";

// Entry test files register the cleanup at their own top level:
// `afterAll(cleanupTempDirs)` — see the shared testkit's doc comment.
export { cleanupTempDirs };

// The /ctl/settings routes lazily initialize the process-global Settings
// singleton on first use; pin it to in-memory so route tests never touch the
// real ~/.omp config. The pin lives at each entry file's top level, NOT here:
// a top-level await in this imported module races bun 1.3.14's parallel
// test-file loader (importers sporadically observe this module's bindings in
// TDZ — "Cannot access 'FAKE_CWD' before initialization").
export async function pinSettingsInMemory(): Promise<void> {
	await Settings.init({ inMemory: true });
}

export const FAKE_CWD = "/tmp/fake-proj";
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

export interface FakeSeen {
	authHeader: string | null;
	calls: unknown[];
	closed: boolean;
}

export interface FakeDaemon {
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
export function startFakeDaemon(token: string, cwd = FAKE_CWD): FakeDaemon {
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
export async function waitFor(
	predicate: () => boolean,
	timeoutMs = 5000,
	what = "condition",
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 20);
		await promise;
	}
	throw new Error(`timed out waiting for ${what}`);
}

export function postJson(port: number, path: string, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

/** `git init -q` (plus extra args) in `cwd`, asserting success. */
export async function gitInit(cwd: string, ...args: string[]): Promise<void> {
	const proc = Bun.spawn(["git", "init", "-q", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	expect(await proc.exited).toBe(0);
}

/**
 * The spawned-child template command used by the spawn tests: prints the
 * fake daemon's listening endpoint on OMP_SESSION (so the supervisor's
 * spawn dial lands on the fake) and then idles forever.
 */
export function ompSessionPrintfCommand(port: number): string {
	return `printf 'OMP_SESSION|%s\\n' '{"event":"listening","bind":"127.0.0.1","port":${port},"url":"ws://127.0.0.1:${port}"}' && while :; do sleep 0.05; done`;
}

export interface FleetPaths {
	tmp: string;
	statePath: string;
	configPath: string;
}

/**
 * Fresh tmp/state/config paths inside a tracked temp dir (see tempDir in
 * ../shared/testkit). Replaces the original suites' raw mkdtempSync describe
 * dirs, which never got rmSync'd. Entry test files register
 * `afterAll(cleanupTempDirs)` at their top level; each bun test file runs in
 * its own process, so one registration per file removes its own dirs.
 */
export function fleetPaths(prefix = "omp-web-test-"): FleetPaths {
	const tmp = tempDir(prefix);
	return { tmp, statePath: join(tmp, "state.json"), configPath: join(tmp, "config.json") };
}

type FleetExtra = Omit<Parameters<typeof startFleet>[0], "port" | "statePath" | "configPath">;

/**
 * Boot a test fleet on ephemeral port 0 against the given paths: writes
 * `config` to configPath, then starts the fleet. `extra` merges into the
 * startFleet options (port/statePath/configPath are owned by this helper).
 */
export async function startTestFleet(
	paths: Pick<FleetPaths, "statePath" | "configPath">,
	config: unknown,
	extra: FleetExtra = {},
): Promise<FleetServer> {
	writeFileSync(paths.configPath, JSON.stringify(config));
	return startFleet({
		port: 0,
		statePath: paths.statePath,
		configPath: paths.configPath,
		...extra,
	});
}
