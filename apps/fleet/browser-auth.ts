/**
 * Browser session authentication primitives (P2.1-P2.3).
 *
 * The browser presents one credential: the opaque `omp_session` cookie value.
 * The access token is presented once per login over the wire, verified
 * constant-time against its stored SHA-256 hash, and never persisted, echoed,
 * or placed in URLs/localStorage. Server-side the store keeps hashes:
 * sha256(sessionId) → record, sha256(csrfToken), and the expected
 * sha256(accessToken), plus the raw csrfToken, which the server re-serves to
 * an authenticated browser after a restart (its ban is client-side:
 * localStorage/URL only, not the 0600 server state file). Expiry is absolute
 * (createdAt + 30 days, never slid); logout/revoke-all/rotation end sessions
 * immediately without sliding anything, and an operator token rotation (a new
 * configuredTokenHash at construction) revokes every session.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const OMP_SESSION_COOKIE = "omp_session";

/** 30-day absolute session lifetime in ms. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** The same lifetime in seconds, for the cookie Max-Age attribute. */
const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;

/** Rejects a login or a misconfigured hash; maps to 401/400 by the caller. */
export class BrowserAuthError extends Error {
	constructor(
		readonly code: "unauthorized" | "invalid_request" | "unavailable",
		message: string,
	) {
		super(message);
	}
}

export interface LoginResult {
	sessionId: string;
	csrfToken: string;
	expiresAt: number;
	/** Full Set-Cookie value for the `omp_session` session cookie. */
	setCookie: string;
}

/** What `authenticate` hands back; hashes plus the session's raw csrfToken. */
export interface AuthenticatedSession {
	sessionIdHash: string;
	createdAt: number;
	expiresAt: number;
	csrfHash: string;
	/** Raw CSRF token, persisted server-side so it survives a restart. */
	csrfToken: string;
}

export interface BrowserAuthStoreOptions {
	/**
	 * Explicit loopback-dev exception: omits the cookie Secure flag (plain
	 * HTTP on 127.0.0.1) and admits loopback origins for mutations. Off in
	 * production; never inferred.
	 */
	loopbackDev?: boolean;
	/**
	 * The operator-configured sha-256 access-token hash (config
	 * browserAccessTokenHash). The configured hash is authoritative:
	 * a fresh store adopts it at construction; a hash DIFFERENT from the
	 * persisted one means the operator rotated the access token, every
	 * live session is revoked (absolute lifetimes are never slid; they end
	 * at rotation) and the new hash is adopted. Absent/equal → no change.
	 */
	configuredTokenHash?: string;
	/** Injectable clock (tests); defaults to Date.now. */
	now?: () => number;
}

interface SessionRecord {
	createdAt: number;
	expiresAt: number;
	csrfHash: string;
	/** Raw token kept server-side only (0600 file) for restart re-serve. */
	csrfToken: string;
	revoked?: boolean;
}

interface PersistedAuth {
	version: 1;
	expectedTokenHash: string | null;
	sessions: Record<string, SessionRecord>;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * True iff sha256(presented) equals a stored 64-hex sha-256 digest.
 * Constant-time over fixed-length buffers; a length mismatch on a malformed
 * stored digest denies rather than throwing from timingSafeEqual.
 */
function secretMatchesDigest(presented: string, storedHexDigest: string): boolean {
	const presentedDigest = Buffer.from(sha256Hex(presented), "utf8");
	const storedDigest = Buffer.from(storedHexDigest, "utf8");
	if (presentedDigest.length !== storedDigest.length) return false;
	return timingSafeEqual(presentedDigest, storedDigest);
}

function sessionCookie(sessionId: string, loopbackDev: boolean, expiresAt: number): string {
	const parts = [
		`${OMP_SESSION_COOKIE}=${sessionId}`,
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${SESSION_TTL_SECONDS}`,
		`Expires=${new Date(expiresAt).toUTCString()}`,
		"Path=/",
	];
	// The loopback-dev exception drops only the Secure flag.
	if (!loopbackDev) parts.splice(2, 0, "Secure");
	return parts.join("; ");
}

/** Set-Cookie value that clears the omp_session cookie (logout, revoke-all
 *  and rotation responses). The Secure flag MUST mirror the session cookie's
 *  own boot decision (loopbackDev), or an https-only cookie would survive
 *  the clear on an http loopback response. */
export function clearSessionCookie(loopbackDev: boolean): string {
	const parts = [
		`${OMP_SESSION_COOKIE}=`,
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
		"Expires=Thu, 01 Jan 1970 00:00:00 GMT",
		"Path=/",
	];
	if (!loopbackDev) parts.splice(2, 0, "Secure");
	return parts.join("; ");
}

function readCookie(req: Request, name: string): string | null {
	const header = req.headers.get("cookie");
	if (header === null) return null;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
	}
	return null;
}

function originFromReferer(referer: string | null): string | null {
	if (referer === null) return null;
	try {
		const origin = new URL(referer).origin;
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

/** True for plain-HTTP loopback origins (the explicit dev exception scope). */
function isLoopbackOrigin(origin: string): boolean {
	try {
		const url = new URL(origin);
		const host = url.hostname.toLowerCase();
		return (
			url.protocol === "http:" &&
			(host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]")
		);
	} catch {
		return false;
	}
}

export class BrowserAuthStore {
	readonly #path: string;
	readonly #loopbackDev: boolean;
	readonly #now: () => number;
	#expectedTokenHash: string | null;
	#sessions = new Map<string, SessionRecord>();

	constructor(path: string, opts: BrowserAuthStoreOptions = {}) {
		this.#path = path;
		this.#loopbackDev = opts.loopbackDev ?? false;
		this.#now = opts.now ?? Date.now;
		const loaded = this.#load();
		this.#expectedTokenHash = loaded?.expectedTokenHash ?? null;
		if (loaded) {
			const now = this.#now();
			// Expired entries are pruned on load; revoked entries are kept.
			for (const [hash, record] of Object.entries(loaded.sessions)) {
				if (record.expiresAt > now) this.#sessions.set(hash, record);
			}
		}
		// Operator token sync (P2.1 rotation): the configured hash is
		// authoritative. A fresh store adopts it; a DIFFERENT hash means the
		// operator rotated the access token, every live session is revoked
		// (absolute lifetimes are never slid; they end now) and the new hash
		// is adopted. Absent → the store keeps whatever it persisted.
		this.#syncConfiguredTokenHash(opts.configuredTokenHash);
	}

	/**
	 * Adopt-or-rotate to the operator-configured access-token hash (see the
	 * constructor). On a hash CHANGE every session is revoked first, so a
	 * rotated token never coexists with sessions minted under the old one.
	 */
	#syncConfiguredTokenHash(configured: string | undefined): void {
		if (configured === undefined || configured === "") return;
		const normalized = configured.toLowerCase();
		if (!SHA256_HEX.test(normalized)) {
			throw new BrowserAuthError(
				"invalid_request",
				"configuredTokenHash must be a sha-256 hex digest",
			);
		}
		if (this.#expectedTokenHash === null) {
			this.#expectedTokenHash = normalized;
			this.#save(); // persist the adoption before any login can happen
		} else if (this.#expectedTokenHash !== normalized) {
			for (const record of this.#sessions.values()) record.revoked = true;
			this.#expectedTokenHash = normalized;
			this.#save();
		}
	}

	/**
	 * Verifies `accessToken` constant-time against the expected token hash and
	 * mints a session. On a store with no hash yet the passed
	 * `expectedTokenHash` is adopted and persisted (direct-store callers and
	 * tests; a fleet boot passes the hash via the constructor's
	 * `configuredTokenHash` instead, so rotation is applied before any
	 * login). Throws `BrowserAuthError`("unauthorized") on a token mismatch
	 * and ("invalid_request") on a malformed hash.
	 */
	login(accessToken: string, expectedTokenHash: string): LoginResult {
		const normalized = expectedTokenHash.toLowerCase();
		if (!SHA256_HEX.test(normalized)) {
			throw new BrowserAuthError(
				"invalid_request",
				"expectedTokenHash must be a sha-256 hex digest",
			);
		}
		if (this.#expectedTokenHash === null) this.#expectedTokenHash = normalized;
		if (!secretMatchesDigest(accessToken, this.#expectedTokenHash)) {
			throw new BrowserAuthError("unauthorized", "access token rejected");
		}
		const now = this.#now();
		const entropy = crypto.getRandomValues(new Uint8Array(64));
		const sessionId = Buffer.from(entropy.subarray(0, 32)).toString("base64url");
		const csrfToken = Buffer.from(entropy.subarray(32)).toString("base64url");
		const record: SessionRecord = {
			createdAt: now,
			expiresAt: now + SESSION_TTL_MS,
			csrfHash: sha256Hex(csrfToken),
			csrfToken,
		};
		this.#sessions.set(sha256Hex(sessionId), record);
		this.#save();
		return {
			sessionId,
			csrfToken,
			expiresAt: record.expiresAt,
			setCookie: sessionCookie(sessionId, this.#loopbackDev, record.expiresAt),
		};
	}

	/** Resolves the session cookie to a live session, or null. Never extends expiry. */
	authenticate(req: Request): AuthenticatedSession | null {
		const sessionId = readCookie(req, OMP_SESSION_COOKIE);
		if (sessionId === null) return null;
		const idHash = sha256Hex(sessionId);
		const record = this.#sessions.get(idHash);
		if (record === undefined || record.revoked === true) return null;
		if (record.expiresAt <= this.#now()) {
			this.#sessions.delete(idHash);
			this.#save();
			return null;
		}
		return {
			sessionIdHash: idHash,
			createdAt: record.createdAt,
			expiresAt: record.expiresAt,
			csrfHash: record.csrfHash,
			csrfToken: record.csrfToken,
		};
	}

	/** Revokes a single session by its raw cookie value. */
	logout(sessionId: string): void {
		const record = this.#sessions.get(sha256Hex(sessionId));
		if (record === undefined || record.revoked === true) return;
		record.revoked = true;
		this.#save();
	}

	/** Revokes every live session (all devices re-login). */
	revokeAll(): void {
		let changed = false;
		for (const record of this.#sessions.values()) {
			if (record.revoked !== true) {
				record.revoked = true;
				changed = true;
			}
		}
		if (changed) this.#save();
	}

	/** Revokes all sessions, then swaps the expected access-token hash. */
	rotateAccessToken(newTokenHash: string): void {
		const normalized = newTokenHash.toLowerCase();
		if (!SHA256_HEX.test(normalized)) {
			throw new BrowserAuthError("invalid_request", "newTokenHash must be a sha-256 hex digest");
		}
		for (const record of this.#sessions.values()) record.revoked = true;
		this.#expectedTokenHash = normalized;
		this.#save();
	}

	/** True iff the X-Omp-Csrf header hashes to the session's csrfHash (timing-safe). */
	requireCsrf(req: Request, session: AuthenticatedSession): boolean {
		const presented = req.headers.get("x-omp-csrf");
		if (presented === null || presented === "") return false;
		return secretMatchesDigest(presented, session.csrfHash);
	}

	/**
	 * Origin/Referer allowlist check for mutations. Denies when neither header
	 * is present (browsers always send Origin on cross-site and same-origin
	 * mutations). Exact normalized match; loopback origins pass only under the
	 * explicit loopback-dev exception.
	 */
	checkOrigin(req: Request, allowedOrigins: readonly string[]): boolean {
		const raw = req.headers.get("origin") ?? originFromReferer(req.headers.get("referer"));
		if (raw === null) return false;
		let normalized: string;
		try {
			normalized = new URL(raw).origin.toLowerCase();
		} catch {
			return false; // not a valid absolute origin (e.g. the literal "null")
		}
		if (this.#loopbackDev && isLoopbackOrigin(normalized)) return true;
		return allowedOrigins.some((allowed) => {
			try {
				return new URL(allowed).origin.toLowerCase() === normalized;
			} catch {
				return false; // malformed allowlist entry can never match
			}
		});
	}

	#load(): PersistedAuth | null {
		let raw: string;
		try {
			raw = readFileSync(this.#path, "utf8");
		} catch (error) {
			// Fresh store: nothing loaded yet. Any other read failure also
			// behaves as fresh rather than corrupting on a later first save.
			const code =
				typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (code === "ENOENT") return null;
			throw new BrowserAuthError("unavailable", `cannot read browser-auth store ${this.#path}`);
		}
		// Fail closed on corruption or a version we do not understand: a
		// silent reset would resurrect revoked sessions. Every field is
		// narrowed and validated before use.
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			throw new BrowserAuthError(
				"unavailable",
				`browser-auth store ${this.#path} is corrupt (not valid JSON)`,
			);
		}
		if (parsed === null || typeof parsed !== "object") {
			throw new BrowserAuthError(
				"invalid_request",
				`browser-auth store ${this.#path} is not an object`,
			);
		}
		const get = (name: string): unknown =>
			name in parsed ? (parsed as Record<string, unknown>)[name] : undefined;
		const version = get("version");
		if (version !== 1) {
			throw new BrowserAuthError(
				"invalid_request",
				`unsupported browser-auth store version in ${this.#path}`,
			);
		}
		const rawExpected = get("expectedTokenHash");
		let expectedTokenHash: string | null;
		if (rawExpected === null) {
			expectedTokenHash = null;
		} else if (typeof rawExpected === "string" && SHA256_HEX.test(rawExpected)) {
			expectedTokenHash = rawExpected;
		} else {
			throw new BrowserAuthError(
				"invalid_request",
				`browser-auth store ${this.#path} has a malformed expected token hash`,
			);
		}
		const rawSessions = get("sessions");
		if (rawSessions === null || typeof rawSessions !== "object") {
			throw new BrowserAuthError(
				"invalid_request",
				`browser-auth store ${this.#path} has no sessions object`,
			);
		}
		const records: Record<string, SessionRecord> = {};
		for (const [hash, value] of Object.entries(rawSessions)) {
			if (!SHA256_HEX.test(hash)) continue; // ignore unkeyed/foreign rows
			if (value === null || typeof value !== "object") {
				throw new BrowserAuthError(
					"invalid_request",
					`browser-auth store ${this.#path} has a malformed session record`,
				);
			}
			const field = (name: string): unknown =>
				name in value ? (value as Record<string, unknown>)[name] : undefined;
			const createdAt = field("createdAt");
			const expiresAt = field("expiresAt");
			const csrfHash = field("csrfHash");
			const csrfToken = field("csrfToken");
			if (
				typeof createdAt !== "number" ||
				typeof expiresAt !== "number" ||
				typeof csrfHash !== "string" ||
				!SHA256_HEX.test(csrfHash) ||
				typeof csrfToken !== "string" ||
				csrfToken.length === 0
			) {
				throw new BrowserAuthError(
					"invalid_request",
					`browser-auth store ${this.#path} has a malformed session record`,
				);
			}
			records[hash] = {
				createdAt,
				expiresAt,
				csrfHash,
				csrfToken,
				revoked: field("revoked") === true ? true : undefined,
			};
		}
		return { version: 1, expectedTokenHash, sessions: records };
	}

	#pruneExpired(): void {
		const now = this.#now();
		for (const [hash, record] of this.#sessions) {
			if (record.expiresAt <= now) this.#sessions.delete(hash);
		}
	}

	#save(): void {
		this.#pruneExpired();
		const tmp = `${this.#path}.tmp`;
		const payload: PersistedAuth = {
			version: 1,
			expectedTokenHash: this.#expectedTokenHash,
			sessions: Object.fromEntries(this.#sessions),
		};
		try {
			mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
			writeFileSync(tmp, `${JSON.stringify(payload, null, "\t")}\n`, { mode: 0o600 });
			chmodSync(tmp, 0o600); // writeFileSync mode is masked by umask
			renameSync(tmp, this.#path);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
	}
}
