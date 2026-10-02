/**
 * Fleet browser-auth route tests (P2.2/P2.3 integration): /auth/login,
 * /auth/session, /auth/logout and the browser-session gate over the shared
 * Bun.serve, exercised over real HTTP like the other server-* suites. The
 * non-loopback peer case boots the fleet on 0.0.0.0 and fetches via the
 * machine's LAN IP (the daemon's R14 token-gate test precedent); it skips
 * with a warning when the host has no non-loopback IPv4 interface.
 *
 * No real omp-session children are spawned.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserAuthStore } from "../browser-auth";
import { BrowserAuthError, FleetAuthGate, peerIsLoopback } from "../fleet-auth-gate";
import { startFleet, type FleetServer } from "../server";
import { compileTrustedProxies } from "../trusted-proxy";
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

/** First non-internal IPv4 address (the machine's LAN IP); undefined when none exists. */
function lanIpv4(): string | undefined {
	for (const addrs of Object.values(os.networkInterfaces())) {
		for (const addr of addrs ?? []) {
			if (addr.family === "IPv4" && !addr.internal) return addr.address;
		}
	}
	return undefined;
}

/** A likely-free TCP port (probe with an ephemeral listen, then release). */
function freePort(): number {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = probe.port!;
	probe.stop(true);
	return port;
}

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

	test("non-loopback peers need a session + CSRF + origin; loopback stays exempt", async () => {
		const lanIp = lanIpv4();
		if (!lanIp) {
			console.warn("no non-loopback IPv4 interface found; skipping non-loopback gate test");
			return;
		}
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-lanauth-");
		// The positive mutation case needs the browser's own origin allowlisted
		// BEFORE boot, so the LAN test binds a fixed (probed-free) port.
		const port = freePort();
		const origin = `http://${lanIp}:${port}`;
		const server = await startFleet({
			port,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
			bind: "0.0.0.0",
			browserAccessToken: TOKEN,
			browserOrigin: origin,
		});
		const base = `http://${lanIp}:${port}`;
		try {
			// Unauthenticated non-loopback peer → 401 on the gated surface.
			expect((await fetch(`${base}/ctl/sessions`)).status).toBe(401);
			expect((await fetch(`${base}/events`)).status).toBe(401);

			// The same request via loopback (the CLI path) is admitted.
			expect((await fetch(`http://127.0.0.1:${port}/ctl/sessions`)).status).toBe(200);

			// Login (public surface) works from the LAN address.
			const good = await login(port, TOKEN);
			expect(good.res.status).toBe(200);
			expect(good.cookie).not.toBeNull();
			const cookie = good.cookie!;

			// Authenticated mutation WITHOUT X-Omp-Csrf → 403.
			const noCsrf = await fetch(`${base}/ctl/spawn`, {
				method: "POST",
				headers: { "content-type": "application/json", cookie },
				body: JSON.stringify({}),
			});
			expect(noCsrf.status).toBe(403);

			// With CSRF but a hostile origin → 403.
			const hostile = await fetch(`${base}/ctl/spawn`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie,
					"x-omp-csrf": good.csrfToken!,
					origin: "https://evil.example.com",
				},
				body: JSON.stringify({}),
			});
			expect(hostile.status).toBe(403);

			// With CSRF + the allowlisted origin → the gate passes and the
			// handler answers (400: empty spawn body), proof of admission.
			const admitted = await fetch(`${base}/ctl/spawn`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					cookie,
					"x-omp-csrf": good.csrfToken!,
					origin,
				},
				body: JSON.stringify({}),
			});
			expect(admitted.status).not.toBe(401);
			expect(admitted.status).not.toBe(403);

			// GET /auth/session over LAN with the cookie works (same-origin
			// probe path a reloaded tab uses).
			expect((await fetch(`${base}/auth/session`, { headers: { cookie } })).status).toBe(200);
		} finally {
			await server.close().catch(() => {});
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

	test("access token is stored hashed, never in plaintext", () => {
		// The test token above is arbitrary; the config key semantics (flag/env
		// plaintext → sha-256 digest at load) are exercised end-to-end by the
		// login tests: the fleet under test authenticates TOKEN, which only
		// works if the stored comparison value is sha256(TOKEN).
		expect(sha256Hex(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
		expect(TOKEN_HASH).not.toBe(TOKEN);
	});

	test("forwarded headers: forged XFF from an untrusted peer is ignored (401)", async () => {
		const lanIp = lanIpv4();
		if (!lanIp) {
			console.warn("no non-loopback IPv4 interface found; skipping untrusted-peer XFF test");
			return;
		}
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-forgedxff-");
		const port = freePort();
		const server = await startFleet({
			port,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
			bind: "0.0.0.0",
			browserAccessToken: TOKEN,
			// NO trusted proxies configured: a direct peer that happens to be
			// the LAN IP is untrusted, so its X-Forwarded-For claiming a
			// loopback client must be IGNORED; the effective client stays
			// the non-loopback LAN peer and a session is required.
		});
		const base = `http://${lanIp}:${port}`;
		try {
			// A hostile XFF trying to claim a loopback client must NOT admit
			// the request: 401 (loopback exemption denied), never 200.
			const forged = await fetch(`${base}/ctl/sessions`, {
				headers: { "x-forwarded-for": "127.0.0.1" },
			});
			expect(forged.status).toBe(401);
			// Same without the header: still 401 (the header changed nothing).
			expect((await fetch(`${base}/ctl/sessions`)).status).toBe(401);
		} finally {
			await server.close().catch(() => {});
		}
	}, 20_000);

	test("forwarded headers: trusted proxy peer's XFF first hop is honored", async () => {
		const lanIp = lanIpv4();
		if (!lanIp) {
			console.warn("no non-loopback IPv4 interface found; skipping trusted-proxy XFF test");
			return;
		}
		await pinSettingsInMemory();
		const paths = fleetPaths("omp-web-server-trustedxff-");
		// The positive case: the fleet trusts the LAN IP as a proxy, so the
		// XFF first hop (127.0.0.1, the browser behind the proxy on the same
		// machine as the proxy's egress) IS honored → loopback exemption.
		const port = freePort();
		const server = await startFleet({
			port,
			statePath: paths.statePath,
			configPath: paths.configPath,
			statsConfig: hermeticStatsConfig(paths.statePath),
			bind: "0.0.0.0",
			browserAccessToken: TOKEN,
			trustedProxy: [lanIp],
		});
		const base = `http://${lanIp}:${port}`;
		try {
			// Direct LAN peer is now trusted; forwarded loopback client is
			// exempt (CLI loopback precedent) → admitted without a cookie.
			const admitted = await fetch(`${base}/ctl/sessions`, {
				headers: { "x-forwarded-for": "127.0.0.1" },
			});
			expect(admitted.status).toBe(200);
			// But a hostile XFF from the same trusted peer naming a NON-loopback
			// client still demands a session (never a silent open door): the
			// forwarded client 203.0.113.7 is not loopback → 401.
			const remote = await fetch(`${base}/ctl/sessions`, {
				headers: { "x-forwarded-for": "203.0.113.7" },
			});
			expect(remote.status).toBe(401);
		} finally {
			await server.close().catch(() => {});
		}
	}, 20_000);
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

	test("XFF first hop is honored from a trusted proxy peer", () => {
		expect(
			gate.clientAddress(req({ "x-forwarded-for": "10.1.2.3, 203.0.113.9" }), "203.0.113.9"),
		).toBe("10.1.2.3");
		// Bare IP trusted rule matches exactly; IPv6 trusted peer too.
		expect(gate.clientAddress(req({ "x-forwarded-for": "10.1.2.3" }), "2001:db8::5")).toBe(
			"10.1.2.3",
		);
		// A loopback first hop through a trusted proxy → loopback exemption.
		expect(gate.authenticate(req({ "x-forwarded-for": "127.0.0.1" }), "203.0.113.9")).toBeNull();
	});

	test("forwarded headers are ignored entirely from an untrusted peer", () => {
		// Peer outside the trusted ranges: even an XFF claiming loopback must
		// NOT admit the request (the effective client stays the untrusted
		// non-loopback peer → session required).
		expect(gate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), "198.51.100.7")).toBe(
			"198.51.100.7",
		);
		expect(gate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), null)).toBe("");
		// The host loopback itself is never a trusted proxy by default: a
		// forwarded header arriving ON the loopback socket is an undeclared
		// proxy and resolves non-loopback (""), fail closed (see below).
		expect(noProxyGate.clientAddress(req({ "x-forwarded-for": "10.0.0.9" }), "127.0.0.1")).toBe("");
	});

	test("loopback peers stay exempt only without forwarded headers", () => {
		// Plain loopback client (CLI / local UI / dev browser): exemption applies.
		expect(peerIsLoopback(noProxyGate.clientAddress(req(), "127.0.0.1"))).toBe(true);
		// A loopback peer carrying ANY forwarded header is an undeclared
		// proxy: resolving non-loopback means the server demands a session,
		// so remote clients behind an unlisted proxy never inherit the
		// loopback exemption, and a hostile XFF on the loopback socket can
		// never forge one.
		expect(
			peerIsLoopback(
				noProxyGate.clientAddress(req({ "x-forwarded-for": "10.0.0.9" }), "127.0.0.1"),
			),
		).toBe(false);
		expect(
			peerIsLoopback(noProxyGate.clientAddress(req({ "x-forwarded-proto": "https" }), "127.0.0.1")),
		).toBe(false);
		expect(
			peerIsLoopback(
				noProxyGate.clientAddress(req({ "x-forwarded-host": "app.example" }), "127.0.0.1"),
			),
		).toBe(false);
		// The configured trusted proxy still resolves the XFF first hop.
		expect(
			peerIsLoopback(gate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), "203.0.113.9")),
		).toBe(true);
	});

	test("X-Forwarded-Proto is honored only from a trusted proxy peer", () => {
		// Untrusted peer's XFP is ignored → the socket scheme (http) wins.
		expect(noProxyGate.clientProto(req({ "x-forwarded-proto": "https" }), "198.51.100.7")).toBe(
			"http",
		);
		// Trusted peer's XFP is honored; garbage/unknown values fall back.
		expect(gate.clientProto(req({ "x-forwarded-proto": "https" }), "203.0.113.9")).toBe("https");
		expect(gate.clientProto(req({ "x-forwarded-proto": "ftp, https" }), "203.0.113.9")).toBe(
			"http",
		);
	});

	test("trusted proxy list itself is never trusted by default", () => {
		// No rules → forwarded headers never shape the client (fail closed).
		expect(noProxyGate.clientAddress(req({ "x-forwarded-for": "127.0.0.1" }), "203.0.113.9")).toBe(
			"203.0.113.9",
		);
	});
});

describe("fleet auth gate revoke-all and rotation passthroughs", () => {
	const authPath = join(tmpdir(), `gate-revoke-${process.pid}-auth.json`);
	afterAll(() => rmSync(authPath, { force: true }));
	const gate = new FleetAuthGate({
		enabled: true,
		loopbackDev: false,
		store: new BrowserAuthStore(authPath),
	});
	const cookieOf = (setCookie: string): string => setCookie.split(";")[0]!;

	test("revokeAll kills every live session; rotation revokes and swaps the hash", () => {
		const first = gate.login(TOKEN, TOKEN_HASH);
		const second = gate.login(TOKEN, TOKEN_HASH);
		const sessionReq = (raw: string): Request =>
			new Request("http://127.0.0.1/ctl/sessions", { headers: { cookie: raw } });
		expect(gate.resolveSession(sessionReq(cookieOf(first.setCookie)))).not.toBeNull();
		expect(gate.resolveSession(sessionReq(cookieOf(second.setCookie)))).not.toBeNull();

		gate.revokeAll();
		expect(gate.resolveSession(sessionReq(cookieOf(first.setCookie)))).toBeNull();
		expect(gate.resolveSession(sessionReq(cookieOf(second.setCookie)))).toBeNull();

		// Rotation: all sessions (including a fresh one) die, the old token
		// stops working, and the new token mints sessions.
		const fresh = gate.login(TOKEN, TOKEN_HASH);
		const rotatedHash = sha256Hex("op-sekret-rotated");
		gate.rotateAccessToken(rotatedHash);
		expect(gate.resolveSession(sessionReq(cookieOf(fresh.setCookie)))).toBeNull();
		expect(() => gate.login(TOKEN, TOKEN_HASH)).toThrow(BrowserAuthError);
		expect(() => gate.login(TOKEN, rotatedHash)).toThrow(/rejected/); // old plaintext vs new hash
		expect(gate.login("op-sekret-rotated", rotatedHash).expiresAt).toBeGreaterThan(0);
	});
});
