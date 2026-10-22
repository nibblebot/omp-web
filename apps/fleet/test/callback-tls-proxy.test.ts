/**
 * One pair socket carries more than Bun's 128 MiB default request-body cap
 * (the reason the proto-1 HTTP up leg renewed its request every 128 MiB) with
 * no reconnect, on the two transports a deployment uses:
 *
 *  1. wss:// through an HTTP CONNECT proxy, certificate verification ON. A
 *     real session half (FleetCallback, spawned as its own process so the trust
 *     anchor comes from NODE_EXTRA_CA_CERTS, which Bun reads at process start,
 *     and the proxy from HTTPS_PROXY) dials a TLS server whose certificate is
 *     signed by the committed test CA (fixtures/ca.pem, localhost.pem; 100
 *     years, SAN localhost and 127.0.0.1; the CA key was discarded after
 *     signing). The same session without the CA must fail to connect, which
 *     proves verification is really on. The server side is NOT the real
 *     `startFleet`: it has no TLS option (it is plain Bun.serve behind an
 *     operator's reverse proxy), so DaemonTransportRegistry is mounted exactly
 *     as apps/fleet/server.ts mounts it (idleTimeout 0, `websocket:
 *     registry.websocket`, `registry.handleFetch` in `fetch`), under a TLS
 *     Bun.serve. Everything past the socket is the real registry.
 *  2. The real `omp-web ui` bridge over plain loopback ws: session ->
 *     startUiServer -> control plane (the same registry mount), in process.
 *
 * Both deliver one down command after the volume, on the same pair.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { startConnectProxy, type ConnectProxy } from "#lib/testkit/connect-proxy.testkit";
import {
	CALLBACK_WS_SEND_HIGH_WATER_BYTES,
	ENVELOPE_MAX_BYTES,
	type CallbackEnvelope,
} from "#lib/wire/callback-protocol";
import { FleetCallback } from "../../session/fleet-callback";
import { DaemonTransportRegistry, type FleetSocketData } from "../daemon-transport";
import { BRIDGE_MAX_BYTES, startUiServer, type BridgeSample } from "../ui-server";
import {
	VOLUME_BYTES,
	VOLUME_FRAMES,
	VOLUME_PAD_BYTES,
	VOLUME_STREAM,
	sendVolume,
} from "./callback-volume.testkit";
import { waitFor } from "./server.testkit";

const WORKSPACE = "ws-volume";
const GENERATION = 1;
const FIXTURES = join(import.meta.dir, "fixtures");
/** Bun's default request-body cap, the size one HTTP up request used to be renewed at. */
const BUN_BODY_CAP_BYTES = 128 * 1024 * 1024;
const PROXY_ENV = [
	"HTTP_PROXY",
	"http_proxy",
	"HTTPS_PROXY",
	"https_proxy",
	"NO_PROXY",
	"no_proxy",
];

const cleanups: Array<() => unknown> = [];
const savedEnv = new Map<string, string | undefined>(
	PROXY_ENV.map((key) => [key, process.env[key]]),
);

beforeAll(() => {
	// The in-process variant resolves proxies from the environment: start from none.
	for (const key of PROXY_ENV) delete process.env[key];
});

afterAll(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

interface ControlPlane {
	registry: DaemonTransportRegistry;
	port: number;
	credential: string;
	/** Volume frames the registry saw, in order, and every ordering or size violation. */
	volume: { frames: number; bytes: number; problems: string[] };
	/** `paired` of every pair change, in order. */
	pairs: boolean[];
}

/** The fleet's callback mount (see server.ts), optionally under TLS, with an enrolled workspace and a volume tap. */
async function startControlPlane(tls?: {
	cert: Bun.BunFile;
	key: Bun.BunFile;
}): Promise<ControlPlane> {
	const registry = new DaemonTransportRegistry();
	const server = Bun.serve<FleetSocketData>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		...(tls !== undefined ? { tls } : {}),
		websocket: registry.websocket,
		fetch: async (req, srv) => {
			const handled = await registry.handleFetch(req, srv);
			return handled === null ? new Response("not found", { status: 404 }) : handled;
		},
	});
	const credential = randomBytes(32).toString("hex");
	await registry.enrollWorkspace(WORKSPACE, GENERATION, credential);
	const volume = { frames: 0, bytes: 0, problems: [] as string[] };
	registry.onDaemonEnvelope(WORKSPACE, (envelope: CallbackEnvelope) => {
		if (envelope.streamId !== VOLUME_STREAM) return;
		const payload = envelope.payload as { i: number; pad: string };
		if (payload.i !== volume.frames) {
			volume.problems.push(`frame ${volume.frames} arrived as ${payload.i}`);
		}
		if (payload.pad.length !== VOLUME_PAD_BYTES) {
			volume.problems.push(`frame ${payload.i} pad is ${payload.pad.length} bytes`);
		}
		volume.frames += 1;
		volume.bytes += payload.pad.length;
	});
	const pairs: boolean[] = [];
	registry.onPairChange(WORKSPACE, (status) => pairs.push(status.paired));
	cleanups.push(() => {
		registry.close();
		void server.stop(true);
	});
	return { registry, port: server.port!, credential, volume, pairs };
}

function sendDownCommand(plane: ControlPlane): Promise<CallbackEnvelope> {
	return plane.registry.sendToDaemon(WORKSPACE, {
		streamId: VOLUME_STREAM,
		kind: "command",
		payload: { type: "call", id: "down-1" },
	});
}

interface SessionProcess {
	events: Array<Record<string, unknown>>;
	/** Resolves with the exit code once the session process ends. */
	exited: Promise<number>;
	stderr: () => string;
	kill(): void;
}

/** Spawn the session half; its stdout JSON lines accumulate in `events`. */
function spawnSession(env: Record<string, string>): SessionProcess {
	const inherited: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !PROXY_ENV.includes(key) && key !== "NODE_EXTRA_CA_CERTS") {
			inherited[key] = value;
		}
	}
	const child = Bun.spawn(["bun", join(import.meta.dir, "callback-tls-proxy-session.testkit.ts")], {
		env: { ...inherited, ...env },
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	});
	cleanups.push(() => child.kill());
	const events: Array<Record<string, unknown>> = [];
	void (async () => {
		let pending = "";
		const decoder = new TextDecoder();
		for await (const chunk of child.stdout) {
			pending += decoder.decode(chunk, { stream: true });
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				events.push(JSON.parse(pending.slice(0, newline)) as Record<string, unknown>);
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
		}
	})();
	let stderrText = "";
	void (async () => {
		for await (const chunk of child.stderr) stderrText += new TextDecoder().decode(chunk);
	})();
	return {
		events,
		exited: child.exited,
		stderr: () => stderrText,
		kill: () => child.kill(),
	};
}

function eventOf(session: SessionProcess, name: string): Record<string, unknown> | undefined {
	return session.events.find((event) => event.event === name);
}

describe("wss through an HTTP CONNECT proxy with certificate verification on", () => {
	async function mountTls(): Promise<{ plane: ControlPlane; proxy: ConnectProxy }> {
		const plane = await startControlPlane({
			cert: Bun.file(join(FIXTURES, "localhost.pem")),
			key: Bun.file(join(FIXTURES, "localhost.key")),
		});
		const proxy = await startConnectProxy();
		cleanups.push(() => proxy.stop());
		return { plane, proxy };
	}

	function sessionEnv(plane: ControlPlane, proxy: ConnectProxy): Record<string, string> {
		return {
			VOLUME_URL: `https://localhost:${plane.port}`,
			VOLUME_WORKSPACE: WORKSPACE,
			VOLUME_TOKEN: plane.credential,
			HTTPS_PROXY: proxy.url,
		};
	}

	test("a real session carries more than 128 MiB up on one socket with no reconnect, then takes a down command", async () => {
		expect(VOLUME_BYTES).toBeGreaterThan(BUN_BODY_CAP_BYTES);
		const { plane, proxy } = await mountTls();
		const session = spawnSession({
			...sessionEnv(plane, proxy),
			NODE_EXTRA_CA_CERTS: join(FIXTURES, "ca.pem"),
		});

		await waitFor(() => eventOf(session, "ready") !== undefined, 15_000, "session ready over wss");
		await waitFor(() => plane.volume.frames === VOLUME_FRAMES, 30_000, "every volume frame");
		const command = await sendDownCommand(plane);
		expect(command.streamId).toBe(VOLUME_STREAM);
		const exitCode = await session.exited;
		expect({ exitCode, stderr: session.stderr() }).toEqual({ exitCode: 0, stderr: "" });

		expect(plane.volume.problems).toEqual([]);
		expect(plane.volume.bytes).toBe(VOLUME_BYTES);
		expect(plane.volume.bytes).toBeGreaterThan(BUN_BODY_CAP_BYTES);
		expect(eventOf(session, "command")).toEqual({ event: "command", id: "down-1" });
		expect(eventOf(session, "final")).toEqual({
			event: "final",
			reconnects: 0,
			readyCount: 1,
			drops: 0,
			rejected: 0,
			badMessages: 0,
		});
		expect(session.events.filter((event) => event.event === "error")).toEqual([]);
		// One pair, one CONNECT through the proxy, and the pair never dropped.
		expect(plane.pairs).toEqual([true]);
		expect(proxy.connects).toEqual([`localhost:${plane.port}`]);
	}, 60_000);

	test("the same session without the test CA cannot connect: verification is on", async () => {
		const { plane, proxy } = await mountTls();
		const session = spawnSession(sessionEnv(plane, proxy));

		await waitFor(
			() => eventOf(session, "error") !== undefined,
			15_000,
			"a certificate verification failure",
		);
		session.kill();
		await session.exited;

		expect(eventOf(session, "ready")).toBeUndefined();
		expect(plane.pairs).toEqual([]);
		expect(plane.volume.frames).toBe(0);
		// The proxy tunnel was opened (the failure is the TLS handshake inside it).
		expect(proxy.connects.length).toBeGreaterThan(0);
	}, 30_000);
});

describe("omp-web ui bridge over loopback ws", () => {
	test("a real session carries more than 128 MiB up through the bridge on one socket with no reconnect, then takes a down command", async () => {
		const plane = await startControlPlane();
		const samples: BridgeSample[] = [];
		const ui = startUiServer({
			port: 0,
			controlPort: plane.port,
			observeBridge: (sample) => samples.push(sample),
		});
		cleanups.push(() => ui.close());
		const commands: CallbackEnvelope[] = [];
		const callback = new FleetCallback(
			{
				url: `http://127.0.0.1:${ui.port}`,
				workspaceId: WORKSPACE,
				generation: GENERATION,
				token: plane.credential,
				allowHttp: true,
				backoffMinMs: 50,
				backoffMaxMs: 200,
			},
			{ onEnvelope: (envelope) => commands.push(envelope) },
		);
		cleanups.push(() => callback.stop());
		await callback.start();

		await sendVolume(callback);
		await waitFor(() => plane.volume.frames === VOLUME_FRAMES, 30_000, "every volume frame");
		await sendDownCommand(plane);
		await waitFor(() => commands.length === 1, 10_000, "down command through the bridge");

		expect(plane.volume.problems).toEqual([]);
		expect(plane.volume.bytes).toBe(VOLUME_BYTES);
		expect(plane.volume.bytes).toBeGreaterThan(BUN_BODY_CAP_BYTES);
		expect(commands[0]!.payload).toEqual({ type: "call", id: "down-1" });
		const status = callback.status();
		expect(status).toMatchObject({ reconnects: 0, readyCount: 1, drops: 0, rejected: 0 });
		expect(plane.pairs).toEqual([true]);
		// The bridge kept its upstream send buffer at the high-water mark plus the envelope that crossed it...
		const peak = Math.max(...samples.map((sample) => sample.upstreamBuffered));
		expect(samples.length).toBeGreaterThan(0);
		expect(peak).toBeLessThanOrEqual(CALLBACK_WS_SEND_HIGH_WATER_BYTES + ENVELOPE_MAX_BYTES);
		// ...and everything it held for the session, queued plus buffered, stayed inside its credit-window bound
		// for the whole 144 MiB: the fleet granted credit only for what it consumed behind the bridge.
		const held = Math.max(...samples.map((s) => s.queuedBytes + s.upstreamBuffered));
		expect(held).toBeLessThanOrEqual(BRIDGE_MAX_BYTES);
	}, 60_000);
});
