/**
 * Unit tests for the browser session store (P2.1): opaque 256-bit session
 * cookies, hashed credentials at rest, HttpOnly Secure SameSite=Lax cookie
 * construction with the explicit loopback-dev Secure exception, absolute
 * 30-day expiry that never slides, and logout / revoke-all / access-token
 * rotation (including the configuredTokenHash boot rotation) invalidating
 * exactly the right sessions, with revocation surviving a reload.
 *
 * The peer-aware gate policy (forwarded headers, CSRF/origin over real HTTP)
 * lives in fleet/server-auth.test.ts; this file tests the store alone.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BrowserAuthError,
	BrowserAuthStore,
	clearSessionCookie,
	OMP_SESSION_COOKIE,
	SESSION_TTL_MS,
} from "./browser-auth";

const sha256Hex = (value: string): string =>
	createHash("sha256").update(value, "utf8").digest("hex");

const TOKEN_A = "op-token-alpha-1";
const HASH_A = sha256Hex(TOKEN_A);
const TOKEN_B = "op-token-beta-2";
const HASH_B = sha256Hex(TOKEN_B);

const TTL_SECONDS = SESSION_TTL_MS / 1000;

const scratch: string[] = [];
function storePath(label: string): string {
	const path = join(tmpdir(), `omp-browser-auth-${label}-${process.pid}-${scratch.length}.json`);
	scratch.push(path);
	return path;
}
afterAll(() => {
	for (const path of scratch) rmSync(path, { force: true });
});

/** The full `omp_session=<id>` segment of a Set-Cookie value (the header a
 *  browser sends back). */
function cookieSegment(setCookie: string): string {
	return setCookie.split(";")[0]!;
}

function cookieRequest(cookie: string | null): Request {
	return new Request("http://127.0.0.1:4722/ctl/sessions", {
		...(cookie !== null ? { headers: { cookie } } : {}),
	});
}

describe("cookie construction", () => {
	test("session cookie: HttpOnly, SameSite=Lax, Secure, Path=/, absolute Max-Age and Expires", () => {
		const now = Date.now();
		const store = new BrowserAuthStore(storePath("cookie"), { now: () => now });
		const login = store.login(TOKEN_A, HASH_A);
		const cookie = login.setCookie;
		expect(cookie).toStartWith(`${OMP_SESSION_COOKIE}=`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Secure");
		expect(cookie).toContain("Path=/");
		expect(cookie).toContain(`Max-Age=${TTL_SECONDS}`);
		// The Expires attribute is the minted ABSOLUTE deadline (UTC seconds
		// granularity, the floor of expiresAt, never later).
		const expiresMatch = /Expires=([^;]+)/.exec(cookie);
		expect(expiresMatch).not.toBeNull();
		const parsed = Date.parse(expiresMatch![1]!);
		expect(parsed).toBeGreaterThan(login.expiresAt - 1000);
		expect(parsed).toBeLessThanOrEqual(login.expiresAt);
	});

	test("loopback-dev exception drops only the Secure flag", () => {
		const store = new BrowserAuthStore(storePath("cookie-dev"), { loopbackDev: true });
		const cookie = store.login(TOKEN_A, HASH_A).setCookie;
		expect(cookie).not.toContain("Secure");
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		expect(cookie).toContain("Path=/");
	});

	test("clearSessionCookie mirrors the Secure decision and expires the cookie", () => {
		expect(clearSessionCookie(false)).toContain("Secure");
		expect(clearSessionCookie(true)).not.toContain("Secure");
		for (const clear of [clearSessionCookie(true), clearSessionCookie(false)]) {
			expect(clear).toStartWith(`${OMP_SESSION_COOKIE}=`);
			expect(clear).toContain("HttpOnly");
			expect(clear).toContain("SameSite=Lax");
			expect(clear).toContain("Max-Age=0");
			expect(clear).toContain("Path=/");
		}
	});
});

describe("login and authenticate", () => {
	test("wrong token and malformed hash are rejected; a live session resolves", () => {
		const store = new BrowserAuthStore(storePath("login"));
		expect(() => store.login("nope", HASH_A)).toThrow(BrowserAuthError);
		expect(() => store.login(TOKEN_A, "not-a-hash")).toThrow(BrowserAuthError);
		expect(store.authenticate(cookieRequest(null))).toBeNull();

		const login = store.login(TOKEN_A, HASH_A);
		const session = store.authenticate(cookieRequest(cookieSegment(login.setCookie)));
		expect(session).not.toBeNull();
		expect(session!.csrfToken).toBe(login.csrfToken);
		expect(session!.sessionIdHash).toBe(sha256Hex(login.sessionId));
		expect(session!.expiresAt).toBe(login.expiresAt);
		// The CSRF token is stored hashed; only the server-held raw copy is served.
		expect(session!.csrfHash).toBe(sha256Hex(login.csrfToken));
	});

	test("an unknown or absent cookie never resolves", () => {
		const store = new BrowserAuthStore(storePath("login-unknown"));
		store.login(TOKEN_A, HASH_A);
		expect(store.authenticate(cookieRequest(`${OMP_SESSION_COOKIE}=deadbeef`))).toBeNull();
		expect(store.authenticate(cookieRequest(null))).toBeNull();
	});

	test("the session cookie is found amid other cookies", () => {
		const store = new BrowserAuthStore(storePath("login-amid"));
		const login = store.login(TOKEN_A, HASH_A);
		expect(
			store.authenticate(cookieRequest(`other=1; ${cookieSegment(login.setCookie)}; pref=2`)),
		).not.toBeNull();
	});
});

describe("absolute expiry never slides", () => {
	test("session dies at exactly expiresAt; repeated use never extends it", () => {
		let now = 1_000_000;
		const store = new BrowserAuthStore(storePath("expiry"), { now: () => now });
		const login = store.login(TOKEN_A, HASH_A);
		expect(login.expiresAt).toBe(now + SESSION_TTL_MS);
		const segment = cookieSegment(login.setCookie);

		// Activity right up to the boundary is fine and does not slide.
		now = login.expiresAt - 1;
		const near = store.authenticate(cookieRequest(segment));
		expect(near).not.toBeNull();
		expect(near!.expiresAt).toBe(login.expiresAt);

		// The exact boundary is dead; the record is pruned.
		now = login.expiresAt;
		expect(store.authenticate(cookieRequest(segment))).toBeNull();
	});

	test("revoked sessions stay dead for their whole (unslid) lifetime", () => {
		let now = 1_000_000;
		const store = new BrowserAuthStore(storePath("expiry-revoked"), { now: () => now });
		const login = store.login(TOKEN_A, HASH_A);
		store.logout(login.sessionId);
		now = login.expiresAt - 1; // still inside the original window
		expect(store.authenticate(cookieRequest(cookieSegment(login.setCookie)))).toBeNull();
	});
});

describe("persistence across reload", () => {
	test("a session and its raw CSRF token survive a store reload", () => {
		const path = storePath("reload");
		const first = new BrowserAuthStore(path);
		const login = first.login(TOKEN_A, HASH_A);
		const segment = cookieSegment(login.setCookie);

		const second = new BrowserAuthStore(path);
		const session = second.authenticate(cookieRequest(segment));
		expect(session).not.toBeNull();
		expect(session!.csrfToken).toBe(login.csrfToken);
		expect(session!.expiresAt).toBe(login.expiresAt);
	});

	test("revocation survives a reload (no resurrection)", () => {
		const path = storePath("reload-revoked");
		const first = new BrowserAuthStore(path);
		const a = first.login(TOKEN_A, HASH_A);
		const b = first.login(TOKEN_A, HASH_A);
		first.revokeAll();

		const second = new BrowserAuthStore(path);
		expect(second.authenticate(cookieRequest(cookieSegment(a.setCookie)))).toBeNull();
		expect(second.authenticate(cookieRequest(cookieSegment(b.setCookie)))).toBeNull();
	});

	test("expired sessions are dropped on reload", () => {
		const path = storePath("reload-expired");
		let now = 1_000_000;
		const first = new BrowserAuthStore(path, { now: () => now });
		const login = first.login(TOKEN_A, HASH_A);
		const segment = cookieSegment(login.setCookie);
		now = first.authenticate(cookieRequest(segment))!.expiresAt; // absolute deadline

		const second = new BrowserAuthStore(path, { now: () => now });
		expect(second.authenticate(cookieRequest(segment))).toBeNull();
	});
});

describe("logout, revoke-all, rotation", () => {
	test("logout revokes exactly the named session", () => {
		const store = new BrowserAuthStore(storePath("logout"));
		const a = store.login(TOKEN_A, HASH_A);
		const b = store.login(TOKEN_A, HASH_A);
		store.logout(a.sessionId);
		expect(store.authenticate(cookieRequest(cookieSegment(a.setCookie)))).toBeNull();
		expect(store.authenticate(cookieRequest(cookieSegment(b.setCookie)))).not.toBeNull();
	});

	test("revoke-all kills every session; a fresh login starts clean", () => {
		const store = new BrowserAuthStore(storePath("revokeall"));
		const a = store.login(TOKEN_A, HASH_A);
		const b = store.login(TOKEN_A, HASH_A);
		store.revokeAll();
		expect(store.authenticate(cookieRequest(cookieSegment(a.setCookie)))).toBeNull();
		expect(store.authenticate(cookieRequest(cookieSegment(b.setCookie)))).toBeNull();
		const c = store.login(TOKEN_A, HASH_A);
		expect(store.authenticate(cookieRequest(cookieSegment(c.setCookie)))).not.toBeNull();
	});

	test("rotateAccessToken revokes every session and swaps the expected hash", () => {
		const store = new BrowserAuthStore(storePath("rotate"), {
			configuredTokenHash: HASH_A,
		});
		const before = store.login(TOKEN_A, HASH_A);
		const segment = cookieSegment(before.setCookie);
		expect(() => store.rotateAccessToken("not-a-hash")).toThrow(BrowserAuthError);

		store.rotateAccessToken(HASH_B);
		expect(store.authenticate(cookieRequest(segment))).toBeNull(); // old session dead
		expect(() => store.login(TOKEN_A, HASH_B)).toThrow(BrowserAuthError); // old token dead
		expect(store.login(TOKEN_B, HASH_B).expiresAt).toBeGreaterThan(0); // new token mints
	});
});

describe("configuredTokenHash boot rotation", () => {
	test("a fresh store adopts the configured hash before any login", () => {
		const store = new BrowserAuthStore(storePath("cfg-fresh"), {
			configuredTokenHash: HASH_A,
		});
		expect(store.login(TOKEN_A, HASH_A).expiresAt).toBeGreaterThan(0);
		expect(() => store.login(TOKEN_B, HASH_B)).toThrow(BrowserAuthError);
	});

	test("an unchanged configured hash leaves sessions alone", () => {
		const path = storePath("cfg-same");
		const first = new BrowserAuthStore(path, { configuredTokenHash: HASH_A });
		const login = first.login(TOKEN_A, HASH_A);
		const segment = cookieSegment(login.setCookie);
		const second = new BrowserAuthStore(path, { configuredTokenHash: HASH_A });
		const session = second.authenticate(cookieRequest(segment));
		expect(session).not.toBeNull();
		expect(session!.expiresAt).toBe(login.expiresAt);
	});

	test("a CHANGED configured hash is an operator rotation: sessions die, new token works", () => {
		const path = storePath("cfg-rotated");
		const first = new BrowserAuthStore(path, { configuredTokenHash: HASH_A });
		const oldLogin = first.login(TOKEN_A, HASH_A);
		const oldSegment = cookieSegment(oldLogin.setCookie);

		// Operator edits the config: restart with the new token hash.
		const second = new BrowserAuthStore(path, { configuredTokenHash: HASH_B });
		expect(second.authenticate(cookieRequest(oldSegment))).toBeNull(); // revoked, not slid
		expect(() => second.login(TOKEN_A, HASH_A)).toThrow(BrowserAuthError);
		expect(second.login(TOKEN_B, HASH_B).expiresAt).toBeGreaterThan(0);

		// The adoption is durable: a third boot without a configured hash
		// still authenticates against the rotated hash only.
		const third = new BrowserAuthStore(path);
		expect(third.login(TOKEN_B, HASH_B).expiresAt).toBeGreaterThan(0);
		expect(() => third.login(TOKEN_A, HASH_A)).toThrow(BrowserAuthError);
	});

	test("a malformed configured hash fails closed at construction", () => {
		expect(
			() => new BrowserAuthStore(storePath("cfg-bad"), { configuredTokenHash: "nope" }),
		).toThrow(BrowserAuthError);
	});
});

describe("corrupt store fails closed", () => {
	test("non-JSON store content throws rather than silently resetting", () => {
		const path = storePath("corrupt-json");
		writeFileSync(path, "{ this is not json");
		expect(() => new BrowserAuthStore(path)).toThrow(BrowserAuthError);
	});
	test("structurally invalid store content throws", () => {
		const path = storePath("corrupt-shape");
		writeFileSync(path, JSON.stringify({ version: 1 }));
		expect(() => new BrowserAuthStore(path)).toThrow(/malformed expected token hash/);
	});
	test("a session record written without the revoked flag reloads as live (pre-revocation writes)", () => {
		// Tampering with the file is out of the trust model, but the load
		// path must tolerate a missing `revoked` field as a live record
		// (backward-compatible writes before the flag existed): a session
		// minted under the CURRENT expected hash is genuinely live.
		const path = storePath("corrupt-flags");
		const first = new BrowserAuthStore(path);
		const login = first.login(TOKEN_A, HASH_A);
		// Hand-write the same shape without the revoked flag.
		const payload = {
			version: 1,
			expectedTokenHash: HASH_A,
			sessions: {
				[sha256Hex(login.sessionId)]: {
					createdAt: login.expiresAt - SESSION_TTL_MS,
					expiresAt: login.expiresAt,
					csrfHash: sha256Hex(login.csrfToken),
					csrfToken: login.csrfToken,
				},
			},
		};
		writeFileSync(path, JSON.stringify(payload));
		const reloaded = new BrowserAuthStore(path);
		expect(reloaded.authenticate(cookieRequest(cookieSegment(login.setCookie)))).not.toBeNull();
	});
});
