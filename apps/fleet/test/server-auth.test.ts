/**
 * Fleet browser-auth route tests (integration): /auth/login,
 * /auth/session, /auth/logout and the browser-session gate over the shared
 * Bun.serve, exercised over real HTTP like the other server-* suites.
 *
 * Non-loopback policy (session/CSRF/origin for a remote client, forwarded
 * headers only from trusted proxies) is exercised at the gate with an
 * INJECTED peer address: startFleet has no seam to fake srv.requestIP, so
 * the gate's peer argument is the injection point (server.ts passes the
 * same value from srv.requestIP at runtime). No host-dependent LAN-interface
 * skips. The browser socket (GET /ws) admission rules need a real upgrade, so
 * they run against a real fleet whose loopback peer is a trusted proxy: the
 * X-Forwarded-For hop is the non-loopback client.
 *
 * No real omp-session children are spawned.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { staleTabEventsBody } from "#lib/wire/browser-socket";
import { OMP_PROTO } from "#lib/wire/protocol";
import { BrowserAuthStore, SESSION_TTL_MS } from "../browser-auth";
import { isLoopbackIp } from "#lib/runtime/browser-guard";
import { FleetAuthGate } from "../fleet-auth-gate";
import { startFleet, type FleetServer } from "../server";
import { compileTrustedProxies } from "../trusted-proxy";
import { BrowserSocket } from "./edge.testkit";
import {
	cleanupTempDirs,
	fleetPaths,
	hermeticStatsConfig,
	pinSettingsInMemory,
	postJson,
} from "./server.testkit";

afterAll(cleanupTempDirs);

const sha256Hex = (value: string): string =>
	createHash("sha256").update(value, "utf8").digest("hex");

const TOKEN = "op-sekret-9f3a";
const TOKEN_HASH = sha256Hex(TOKEN);

interface LoginOutcome {
	res: Response;
	cookie: string | null;
	csrfToken: string | null;
	expiresAt: number | null;
}

/** POST /auth/login; returns the Response plus the parsed cookie/body fields. */
async function login(port: number, accessToken: string): Promise<LoginOutcome> {
	const res = await postJson(port, "/auth/login", { accessToken });
	const setCookie = res.headers.get("set-cookie");
	const body = (await res.json().catch(() => ({}))) as {
		csrfToken?: unknown;
		expiresAt?: unknown;
	};
	return {
		res,
		cookie: setCookie !== null ? setCookie.split(";")[0]! : null,
		csrfToken: typeof body.csrfToken === "string" ? body.csrfToken : null,
		expiresAt:
			typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt) ? body.expiresAt : null,
	};
}

async function sessionProbe(port: number, cookie: string | null): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}/auth/session`, {
		...(cookie !== null ? { headers: { cookie } } : {}),
	});
}

describe("fleet browser auth", () => {
	test("configured: login, session probe, logout, restart recovery", async () => {
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-auth-");
		let server: FleetServer | null = null;
		try {
			server = await startFleet({
				port: 0,
				statePath: paths.statePath,
				configPath: paths.configPath,
				statsConfig: hermeticStatsConfig(paths.statePath),
				browserAccessToken: TOKEN,
			});
			const port = server.port;

			// Loopback control plane stays CLI-admitted without any cookie.
			expect((await fetch(`http://127.0.0.1:${port}/ctl/sessions`)).status).toBe(200);
			// No session yet → the probe answers 401.
			expect((await sessionProbe(port, null)).status).toBe(401);

			// Wrong token → 401, no cookie.
			const wrong = await login(port, "nope");
			expect(wrong.res.status).toBe(401);
			expect(wrong.cookie).toBeNull();

			// Right token → Set-Cookie + {sessionIdHash, csrfToken, expiresAt}.
			const good = await login(port, TOKEN);
			expect(good.res.status).toBe(200);
			expect(good.cookie).toStartWith("omp_session=");
			expect(good.csrfToken).not.toBeNull();
			expect(typeof good.csrfToken).toBe("string");
			expect(good.expiresAt).not.toBeNull();
			expect(good.expiresAt!).toBeGreaterThan(Date.now());

			// Session probe with the cookie → same raw csrfToken + expiry.
			const probe = await sessionProbe(port, good.cookie);
			expect(probe.status).toBe(200);
			const probeBody = (await probe.json()) as {
				csrfToken?: unknown;
				expiresAt?: unknown;
				sessionIdHash?: unknown;
			};
			expect(probeBody.csrfToken).toBe(good.csrfToken);
			expect(probeBody.expiresAt).toBe(good.expiresAt);
			expect(typeof probeBody.sessionIdHash).toBe("string");

			// Fleet restart on the same state dir: the persisted store reloads
			// the session AND its raw csrfToken (no re-login needed).
			await server.close();
			server = await startFleet({
				port: 0,
				statePath: paths.statePath,
				configPath: paths.configPath,
				statsConfig: hermeticStatsConfig(paths.statePath),
				browserAccessToken: TOKEN,
			});
			const probe2 = await sessionProbe(server.port, good.cookie);
			expect(probe2.status).toBe(200);
			const body2 = (await probe2.json()) as { csrfToken?: unknown; expiresAt?: unknown };
			expect(body2.csrfToken).toBe(good.csrfToken);
			expect(body2.expiresAt).toBe(good.expiresAt);

			// Logout revokes: the probe 401s afterwards.
			const logout = await fetch(`http://127.0.0.1:${server.port}/auth/logout`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie: good.cookie! },
			});
			expect(logout.status).toBe(200);
			expect((await sessionProbe(server.port, good.cookie)).status).toBe(401);
		} finally {
			if (server !== null) await server.close().catch(() => {});
		}
	}, 20_000);

	test("without a browser token: /auth/session 404 and everything admitted as before", async () => {
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-noauth-");
		const server = await startFleet({
			port: 0,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
		});
		try {
			const port = server.port;
			expect((await fetch(`http://127.0.0.1:${port}/auth/session`)).status).toBe(404);
			expect((await postJson(port, "/auth/login", { accessToken: "x" })).status).toBe(404);
			expect((await fetch(`http://127.0.0.1:${port}/ctl/sessions`)).status).toBe(200);
			expect((await postJson(port, "/ctl/spawn", {})).status).toBe(400); // handler ran, not gated
		} finally {
			await server.close().catch(() => {});
		}
	});

	test("non-loopback bind without a browser token is a startup error", async () => {
		const paths = fleetPaths("omp-web-server-bindfail-");
		await expect(
			startFleet({
				port: 0,
				statePath: paths.statePath,
				configPath: paths.configPath,
				statsConfig: hermeticStatsConfig(paths.statePath),
				bind: "0.0.0.0",
			}),
		).rejects.toThrow(/non-loopback/);
	});

	test("the persisted auth store keeps the token hashed, never in plaintext", async () => {
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-authhash-");
		const server = await startFleet({
			port: 0,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
			browserAccessToken: TOKEN,
		});
		try {
			// A login persists a session record; the store lives next to the
			// state file (server.ts: dirname(statePath)/browser-auth.json).
			expect((await login(server.port, TOKEN)).res.status).toBe(200);
			const raw = readFileSync(join(dirname(paths.statePath), "browser-auth.json"), "utf8");
			expect(raw).not.toContain(TOKEN);
			expect(raw).toContain(TOKEN_HASH);
		} finally {
			await server.close().catch(() => {});
		}
	});

	test("repeated wrong tokens lock the client out with 429, even for the right token", async () => {
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-throttle-");
		const server = await startFleet({
			port: 0,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
			browserAccessToken: TOKEN,
		});
		try {
			// The first five wrong tokens are free; the sixth opens a one-second lock.
			for (let i = 0; i < 6; i++) {
				expect((await login(server.port, "nope")).res.status).toBe(401);
			}
			const locked = await postJson(server.port, "/auth/login", { accessToken: TOKEN });
			expect(locked.status).toBe(429);
			expect(locked.headers.get("set-cookie")).toBeNull();
			const lockedBody: unknown = await locked.json();
			expect(lockedBody).toMatchObject({
				error: {
					code: "rate_limited",
					message: expect.stringContaining("too many failed sign-ins"),
				},
			});
		} finally {
			await server.close().catch(() => {});
		}
	}, 20_000);

	test("a successful sign-in clears the failure count", async () => {
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-throttle-reset-");
		const server = await startFleet({
			port: 0,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
			browserAccessToken: TOKEN,
		});
		try {
			for (let i = 0; i < 5; i++) {
				expect((await login(server.port, "nope")).res.status).toBe(401);
			}
			expect((await login(server.port, TOKEN)).res.status).toBe(200);
			// The count restarted at zero, so five more wrong tokens are still free.
			for (let i = 0; i < 5; i++) {
				expect((await login(server.port, "nope")).res.status).toBe(401);
			}
		} finally {
			await server.close().catch(() => {});
		}
	}, 20_000);

	test("pre-auth login bodies are capped at 4 KiB; non-JSON is 415 (FEDGE-11)", async () => {
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-body-cap-");
		const server = await startFleet({
			port: 0,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
			browserAccessToken: TOKEN,
		});
		try {
			const url = `http://127.0.0.1:${server.port}/auth/login`;
			const text = await fetch(url, {
				method: "POST",
				headers: { "content-type": "text/plain" },
				body: "accessToken=nope",
			});
			expect(text.status).toBe(415);
			const oversize = JSON.stringify({ accessToken: "x".repeat(8 * 1024) });
			// Declared length over the cap is refused before the body is read.
			const declared = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: oversize,
			});
			expect(declared.status).toBe(413);
			// Chunked (no content-length): the read is cut off once it passes the cap.
			const chunked = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(oversize));
						controller.close();
					},
				}),
			});
			expect(chunked.status).toBe(413);
		} finally {
			await server.close().catch(() => {});
		}
	}, 20_000);
});

describe("fleet auth gate non-loopback policy (injected peer)", () => {
	// Deterministic equivalent of the former LAN-interface gate tests: the
	// gate's peer argument is the seam (server.ts passes srv.requestIP's
	// address), so the remote-client session + CSRF + origin policy runs
	// everywhere instead of skipping on hosts without a non-loopback IPv4.
	const authPath = join(tmpdir(), `gate-nonloop-${process.pid}-auth.json`);
	afterAll(() => rmSync(authPath, { force: true }));
	const browserOrigin = "https://ui.example.com";
	const gate = new FleetAuthGate({
		enabled: true,
		loopbackDev: false,
		store: new BrowserAuthStore(authPath),
		browserOrigin,
	});
	const client = "203.0.113.9";
	const req = (headers: Record<string, string> = {}): Request =>
		new Request("http://127.0.0.1/ctl/sessions", { headers });

	test("a non-loopback client needs a session; mutations need CSRF and the allowlisted origin", () => {
		// No cookie → no session: server.ts maps a null authenticate to 401.
		expect(gate.authenticate(req(), client)).toBeNull();
		const loginResult = gate.login(TOKEN, TOKEN_HASH, client);
		const cookie = loginResult.setCookie.split(";")[0]!;
		const session = gate.authenticate(req({ cookie }), client);
		expect(session).not.toBeNull();
		// A mutation without X-Omp-Csrf is refused (403)...
		expect(gate.requireCsrf(req({ cookie }), session!)).toBe(false);
		// ...with it passes, but a hostile Origin is still refused while the
		// configured allowlisted origin is admitted.
		const csrf = { cookie, "x-omp-csrf": loginResult.csrfToken };
		expect(gate.requireCsrf(req(csrf), session!)).toBe(true);
		expect(gate.checkOrigin(req({ ...csrf, origin: "https://evil.example.com" }))).toBe(false);
		expect(gate.checkOrigin(req({ ...csrf, origin: browserOrigin }))).toBe(true);
	});
});

describe("fleet auth gate forwarded-header resolution", () => {
	// Deterministic unit-level coverage (no LAN interface dependency): the
	// gate resolves X-Forwarded-For / X-Forwarded-Proto ONLY when the direct
	// peer matches the compiled trusted-proxy rules.
	const store = new BrowserAuthStore(join(tmpdir(), `gate-resolve-${process.pid}-auth.json`), {});
	const gate = new FleetAuthGate({
		enabled: true,
		loopbackDev: false,
		store,
		trustedProxies: compileTrustedProxies(["203.0.113.0/24", "2001:db8::/32"]).rules,
	});
	const noProxyGate = new FleetAuthGate({
		enabled: true,
		loopbackDev: false,
		store,
	});
	const req = (headers: Record<string, string> = {}): Request =>
		new Request("http://127.0.0.1/ctl/sessions", { headers });

	test("XFF client hop is resolved from a trusted proxy peer", () => {
		expect(
			gate.clientAddress(req({ "x-forwarded-for": "10.1.2.3, 203.0.113.9" }), "203.0.113.9"),
		).toBe("10.1.2.3");
		// Bare IP trusted rule matches exactly; IPv6 trusted peer too.
		expect(gate.clientAddress(req({ "x-forwarded-for": "10.1.2.3" }), "2001:db8::5")).toBe(
			"10.1.2.3",
		);
		// A loopback hop from a trusted proxy is not the client when the socket
		// peer is remote: the resolved client is never loopback.
		const loopbackHop = gate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), "203.0.113.9");
		expect(isLoopbackIp(loopbackHop)).toBe(false);
		expect(gate.authenticate(req({ "x-forwarded-for": "127.0.0.1" }), loopbackHop)).toBeNull();
		// A forwarded NON-loopback client hop from the same trusted peer still
		// demands a session: a null authenticate is the 401 server.ts emits.
		const forwarded = req({ "x-forwarded-for": "198.51.100.7" });
		const forwardedClient = gate.clientAddress(forwarded, "203.0.113.9");
		expect(forwardedClient).toBe("198.51.100.7");
		expect(gate.authenticate(forwarded, forwardedClient)).toBeNull();
	});

	test("forwarded headers are ignored entirely from an untrusted peer", () => {
		// Peer outside the trusted ranges: even an XFF claiming loopback must
		// NOT admit the request (the effective client stays the untrusted
		// non-loopback peer → session required).
		expect(gate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), "198.51.100.7")).toBe(
			"198.51.100.7",
		);
		expect(gate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), null)).toBe("");
		// The forged loopback claim never buys the exemption: the effective
		// client is the peer, and the gate still demands a session (401).
		const forged = req({ "x-forwarded-for": "127.0.0.1" });
		const forgedClient = gate.clientAddress(forged, "198.51.100.7");
		expect(isLoopbackIp(forgedClient)).toBe(false);
		expect(gate.authenticate(forged, forgedClient)).toBeNull();
		// The host loopback itself is never a trusted proxy by default: a
		// forwarded header arriving ON the loopback socket is an undeclared
		// proxy and resolves non-loopback (""), fail closed (see below).
		expect(noProxyGate.clientAddress(req({ "x-forwarded-for": "10.0.0.9" }), "127.0.0.1")).toBe("");
	});

	test("loopback peers stay exempt only without forwarded headers", () => {
		// Plain loopback client (CLI / local UI / dev browser): exemption applies.
		expect(isLoopbackIp(noProxyGate.clientAddress(req(), "127.0.0.1"))).toBe(true);
		// A loopback peer carrying ANY forwarded header is an undeclared
		// proxy: resolving non-loopback means the server demands a session,
		// so remote clients behind an unlisted proxy never inherit the
		// loopback exemption, and a hostile XFF on the loopback socket can
		// never forge one.
		expect(
			isLoopbackIp(noProxyGate.clientAddress(req({ "x-forwarded-for": "10.0.0.9" }), "127.0.0.1")),
		).toBe(false);
		expect(
			isLoopbackIp(noProxyGate.clientAddress(req({ "x-forwarded-proto": "https" }), "127.0.0.1")),
		).toBe(false);
		expect(
			isLoopbackIp(
				noProxyGate.clientAddress(req({ "x-forwarded-host": "app.example" }), "127.0.0.1"),
			),
		).toBe(false);
		// A loopback hop through a trusted proxy with a remote socket peer never
		// resolves as loopback: the exemption belongs to the socket peer alone.
		expect(
			isLoopbackIp(gate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), "203.0.113.9")),
		).toBe(false);
	});

	test("trusted proxy list itself is never trusted by default", () => {
		// No rules → forwarded headers never shape the client (fail closed).
		expect(noProxyGate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), "203.0.113.9")).toBe(
			"203.0.113.9",
		);
	});

	test("appended loopback hops never resolve as loopback; the client is the rightmost untrusted hop", () => {
		const chain = new FleetAuthGate({
			enabled: true,
			loopbackDev: false,
			store,
			trustedProxies: compileTrustedProxies(["10.0.0.0/8", "203.0.113.0/24"]).rules,
		});
		// A proxy appends the peer it saw after a client-supplied leftmost hop.
		expect(
			chain.clientAddress(req({ "x-forwarded-for": "127.0.0.1, 198.51.100.7" }), "10.0.0.5"),
		).toBe("198.51.100.7");
		// Multi-proxy chain: trusted hops on the right are skipped; the spoofed
		// leftmost loopback hop is never consulted.
		expect(
			chain.clientAddress(
				req({ "x-forwarded-for": "127.0.0.1, 198.51.100.7, 10.0.0.2" }),
				"203.0.113.9",
			),
		).toBe("198.51.100.7");
		// A header made only of trusted hops resolves to the peer.
		expect(
			chain.clientAddress(req({ "x-forwarded-for": "10.0.0.2, 203.0.113.9" }), "10.0.0.5"),
		).toBe("10.0.0.5");
		// An empty hop fails closed.
		expect(chain.clientAddress(req({ "x-forwarded-for": "198.51.100.7, " }), "10.0.0.5")).toBe("");
	});
});

describe("browser socket admission (/ws on a real fleet, browser auth on)", () => {
	const ORIGIN = "https://ui.example.com";
	/** The proxied client hop: the test's loopback peer is a trusted proxy, so this address is the client. */
	const REMOTE = { "x-forwarded-for": "203.0.113.50" };
	let server: FleetServer;
	let port: number;
	const sockets: BrowserSocket[] = [];

	beforeAll(async () => {
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-auth-ws-");
		server = await startFleet({
			port: 0,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
			browserAccessToken: TOKEN,
			browserOrigin: ORIGIN,
			trustedProxy: ["127.0.0.1"],
		});
		port = server.port;
	});

	afterAll(async () => {
		for (const socket of sockets) socket.close();
		setSystemTime();
		await server?.close().catch(() => {});
	});

	/** Dial /ws with extra upgrade headers; resolves once open (a refusal opens, then closes typed). */
	async function dial(headers: Record<string, string>): Promise<BrowserSocket> {
		const socket = new BrowserSocket(port, undefined, { headers });
		sockets.push(socket);
		await socket.open();
		return socket;
	}

	async function signIn(): Promise<string> {
		const outcome = await login(port, TOKEN);
		expect(outcome.res.status).toBe(200);
		return outcome.cookie!;
	}

	/** An admitted socket is primed and still open. */
	async function expectAdmitted(socket: BrowserSocket): Promise<void> {
		await socket.waitForFrame((f) => f.type === "roster", "priming roster");
		expect(socket.closeInfo).toBeNull();
	}

	/** A refused socket closes with the typed code before any frame is delivered. */
	async function expectRefused(socket: BrowserSocket, code: number, kind: string): Promise<void> {
		const close = await socket.end();
		expect(close.code).toBe(code);
		expect(close.reason).toStartWith(`${kind}:`);
		expect(socket.messages).toEqual([]);
	}

	test("a proxied non-loopback client with a session cookie and the configured origin is admitted and primed", async () => {
		const cookie = await signIn();
		await expectAdmitted(await dial({ ...REMOTE, cookie, origin: ORIGIN }));
	});

	test("a proxied non-loopback client with a session cookie but a foreign origin closes 4403", async () => {
		const cookie = await signIn();
		await expectRefused(
			await dial({ ...REMOTE, cookie, origin: "https://evil.example" }),
			4403,
			"forbidden",
		);
	});

	test("a proxied non-loopback client with no Origin header is refused 4403 even with a live session", async () => {
		const cookie = await signIn();
		await expectRefused(await dial({ ...REMOTE, cookie }), 4403, "forbidden");
	});

	test("a proxied non-loopback client with no cookie, or a cookie that is not a session, closes 4401", async () => {
		await expectRefused(await dial({ ...REMOTE, origin: ORIGIN }), 4401, "unauthorized");
		await expectRefused(
			await dial({ ...REMOTE, origin: ORIGIN, cookie: "omp_session=not-a-session" }),
			4401,
			"unauthorized",
		);
	});

	test("a loopback peer with a foreign Origin closes 4403 (FEDGE-02); without one it is admitted with no session", async () => {
		await expectRefused(await dial({ origin: "https://evil.example" }), 4403, "forbidden");
		await expectAdmitted(await dial({}));
	});

	test("GET /ws without an upgrade is HTTP 426, any other method 405", async () => {
		const plain = await fetch(`http://127.0.0.1:${port}/ws`);
		expect(plain.status).toBe(426);
		expect(plain.headers.get("upgrade")).toBe("websocket");
		const post = await fetch(`http://127.0.0.1:${port}/ws`, { method: "POST", body: "{}" });
		expect(post.status).toBe(405);
	});

	test("stale GET /events and POST /command answer without a session while the gate is on", async () => {
		// The control: with the same proxied, cookie-less client the data routes are gated.
		const gated = await fetch(`http://127.0.0.1:${port}/ctl/sessions`, { headers: REMOTE });
		expect(gated.status).toBe(401);
		const events = await fetch(`http://127.0.0.1:${port}/events?client=old-tab`, {
			headers: REMOTE,
		});
		expect(events.status).toBe(200);
		expect(events.headers.get("content-type")).toContain("text/event-stream");
		expect(await events.text()).toBe(staleTabEventsBody(OMP_PROTO));
		const command = await fetch(`http://127.0.0.1:${port}/command`, {
			method: "POST",
			headers: { ...REMOTE, "content-type": "application/json", "x-omp-client-id": "old-tab" },
			body: JSON.stringify({ type: "sync_projects", id: "x" }),
		});
		expect(command.status).toBe(410);
		expect(await command.json()).toEqual({ error: "proto_unsupported" });
	});

	test("sign-out closes that session's sockets 4401 and leaves another session's socket open", async () => {
		const cookieA = await signIn();
		const cookieB = await signIn();
		expect(cookieA).not.toBe(cookieB);
		const a1 = await dial({ ...REMOTE, cookie: cookieA, origin: ORIGIN });
		const a2 = await dial({ ...REMOTE, cookie: cookieA, origin: ORIGIN });
		const b = await dial({ ...REMOTE, cookie: cookieB, origin: ORIGIN });
		await Promise.all([expectAdmitted(a1), expectAdmitted(a2), expectAdmitted(b)]);

		const logout = await fetch(`http://127.0.0.1:${port}/auth/logout`, {
			method: "POST",
			headers: { "content-type": "application/json", cookie: cookieA },
		});
		expect(logout.status).toBe(200);
		for (const closed of [a1, a2]) {
			expect(await closed.end()).toEqual({ code: 4401, reason: "unauthorized: signed out" });
		}
		// The other session's socket is untouched and still takes commands.
		expect(b.closeInfo).toBeNull();
		await b.send({ type: "bogus_command" });
		expect(b.closeInfo).toBeNull();
		// The signed-out session can not dial again.
		await expectRefused(
			await dial({ ...REMOTE, cookie: cookieA, origin: ORIGIN }),
			4401,
			"unauthorized",
		);
	});

	test("a session that expires closes its socket 4401 at the next command", async () => {
		const cookie = await signIn();
		const socket = await dial({ ...REMOTE, cookie, origin: ORIGIN });
		await expectAdmitted(socket);
		try {
			// The edge judges expiry against Date.now: move the clock past the 30-day TTL.
			setSystemTime(new Date(Date.now() + SESSION_TTL_MS + 60_000));
			await socket.send({ type: "bogus_command" }).catch(() => {});
		} finally {
			setSystemTime();
		}
		expect(await socket.end()).toEqual({ code: 4401, reason: "unauthorized: session expired" });
	});
});
