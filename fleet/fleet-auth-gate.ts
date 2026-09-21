/**
 * Fleet browser-auth wiring glue (P2.2/P2.3) shared by fleet/server.ts and
 * fleet/edge.ts. Deliberately NOT part of fleet/browser-auth.ts (that module
 * is a pure session store owned by the P2 lane; if it ever changes, this
 * file is the single place the gate policy adapts).
 *
 * Gate policy:
 *   - Browser auth DISABLED (no operator access token configured): every
 *     request is admitted; /auth/session still answers 404 so clients probe
 *     the disabled state and behave exactly as before this integration.
 *   - Client-address resolution (P2.3 trusted proxies): the direct socket
 *     peer is the default client. X-Forwarded-For / X-Forwarded-Proto are
 *     honored ONLY when the direct peer matches the configured
 *     trustedProxies list (IP/CIDR literals); then the FIRST XFF hop is the
 *     client address and XFP may mark the request forwarded-over-https.
 *     Forwarded headers from any untrusted peer are ignored entirely,
 *     never trusted by default, and hostile values can never admit a
 *     loopback exemption or the origin allowlist (fail closed). XFP has no
 *     consumer past resolution: checkOrigin compares the PRESENTED absolute
 *     origin against the allowlist, and the cookie Secure flag is a boot
 *     decision (loopbackDev), never per-request header state.
 *   - Loopback-client requests (the fleet/cli.ts control-plane precedent,
 *     R14) are exempt from the browser-session check; they carry no cookie.
 *     A loopback peer that DOES carry forwarded headers is an undeclared
 *     proxy: it resolves as a non-loopback client (session required) until
 *     the proxy is listed in trustedProxies, fail closed, never an open
 *     door for remote clients behind an unlisted proxy.
 *   - When enabled, /ctl/* and edge browser routes require a live browser
 *     session (authenticate) unless the client is loopback; mutations
 *     additionally require requireCsrf + checkOrigin (allowlist = the
 *     configured public browser origin + the loopback-dev exception).
 *     revokeAll()/rotateAccessToken() are store passthroughs for gated
 *     mutation mounts (POST /ctl/auth/revoke-all, /ctl/auth/rotate-token).
 *   - /callback/* NEVER rides this gate: the transport registry
 *     authenticates those routes with the workspace enrollment credentials.
 *
 * The /auth/* login/session/logout surface is PUBLIC (it IS the login
 * surface): browsers may reach it from loopback in dev and from the public
 * origin in production, so those routes call the raw store, never the
 * peer-aware gate. Only the protected surface (everything else) is gated.
 */

import { createHash } from "node:crypto";
import { isLoopbackHost } from "../server/config";
import { isTrustedProxy, type ProxyRule } from "./trusted-proxy";
import {
	BrowserAuthStore,
	BrowserAuthError,
	OMP_SESSION_COOKIE,
	type AuthenticatedSession,
	type LoginResult,
} from "./browser-auth";

export type { AuthenticatedSession };

/** True for a plain-HTTP loopback bind address (the loopback-dev cookie
 *  exception scope); mirrors browser-auth's origin-side test. */
export function isLoopbackBind(bind: string): boolean {
	try {
		const host = new URL(`http://${bind}`).hostname;
		return isLoopbackHost(host);
	} catch {
		return isLoopbackHost(bind);
	}
}

const emptyAllowlist: readonly string[] = [];
const emptyRules: readonly ProxyRule[] = [];

/**
 * One gate instance, shared by the fleet server (its own routes) and the
 * edge (mounted routes). Owns client-address resolution (trusted proxies),
 * the mutation allowlist (configured public browser origin + the loopback-dev
 * exception, which browser-auth applies internally when loopbackDev is on)
 * and the public /auth surface.
 */
export class FleetAuthGate {
	readonly enabled: boolean;
	readonly loopbackDev: boolean;
	readonly #store: BrowserAuthStore;
	readonly #allowedOrigins: readonly string[];
	/** Compiled trusted-proxy rules (gate construction); empty = forwarded
	 *  headers are never honored. */
	readonly #trustedProxies: readonly ProxyRule[];

	constructor(opts: {
		enabled: boolean;
		loopbackDev: boolean;
		store: BrowserAuthStore;
		/** Public browser origin for mutations (config.browserOrigin); optional. */
		browserOrigin?: string;
		/** Compiled trusted-proxy rules (compileTrustedProxies); forwarded
		 *  headers honored only when the direct peer matches. */
		trustedProxies?: readonly ProxyRule[];
	}) {
		this.enabled = opts.enabled;
		this.loopbackDev = opts.loopbackDev;
		this.#store = opts.store;
		this.#allowedOrigins =
			opts.browserOrigin !== undefined && opts.browserOrigin !== ""
				? [opts.browserOrigin]
				: emptyAllowlist;
		this.#trustedProxies = opts.trustedProxies ?? emptyRules;
	}

	// --- public /auth surface (raw store; never peer-gated) -------------------

	/** POST /auth/login: verify the presented access token against the stored
	 *  expected hash and mint a session. Throws BrowserAuthError. */
	login(accessToken: string, expectedTokenHash: string): LoginResult {
		return this.#store.login(accessToken, expectedTokenHash);
	}

	/** POST /auth/logout: revoke the session named by the cookie. */
	logout(sessionId: string): void {
		this.#store.logout(sessionId);
	}

	/** Revokes every live browser session (all devices re-login). Mount as a
	 *  mutation (e.g. POST /ctl/auth/revoke-all) so it inherits the
	 *  session + CSRF + origin gate; never a bare /auth route. */
	revokeAll(): void {
		this.#store.revokeAll();
	}

	/** Operator access-token rotation: revokes every session (absolute
	 *  lifetimes end at rotation, nothing slides) and adopts the new
	 *  expected sha-256 hash. Mount as a gated mutation. */
	rotateAccessToken(newTokenHash: string): void {
		this.#store.rotateAccessToken(newTokenHash);
	}

	/** GET /auth/session: resolve the request's cookie to a live session.
	 *  The raw CSRF token rides AuthenticatedSession (browser-auth persists
	 *  it server-side in the 0600 store), so sessions survive fleet
	 *  restarts without a re-login. */
	resolveSession(req: Request): { session: AuthenticatedSession; csrfToken: string } | null {
		const session = this.#store.authenticate(req);
		if (session === null) return null;
		return { session, csrfToken: session.csrfToken };
	}

	/** Raw value of the omp_session cookie (login/logout need the raw id to
	 *  mint/revoke; resolveSession is the read path). */
	sessionCookie(req: Request): string | null {
		const header = req.headers.get("cookie");
		if (header === null) return null;
		for (const part of header.split(";")) {
			const eq = part.indexOf("=");
			if (eq === -1) continue;
			if (part.slice(0, eq).trim() === OMP_SESSION_COOKIE) return part.slice(eq + 1).trim();
		}
		return null;
	}

	/** sha-256 hex of a raw session id: the wire's sessionIdHash (public, it
	 *  only maps a cookie to its record; the cookie value stays HttpOnly). */
	sessionIdHash(sessionId: string): string {
		return createHash("sha256").update(sessionId, "utf8").digest("hex");
	}

	/** The { sessionIdHash, csrfToken, expiresAt } body of the login/session
	 *  answers (src/store/auth.ts caches csrfToken for mutation headers and
	 *  reads expiresAt for the UI). */
	sessionBody(sessionId: string, csrfToken: string, expiresAt: number): Record<string, unknown> {
		return { sessionIdHash: this.sessionIdHash(sessionId), csrfToken, expiresAt };
	}

	// --- protected-surface gate (peer-aware) ----------------------------------

	/** Effective client address for this request: the direct socket peer,
	 *  replaced by the FIRST X-Forwarded-For hop only when the direct peer
	 *  matches the configured trusted proxies. Forwarded headers from any
	 *  other peer are ignored entirely (never trusted by default; hostile
	 *  values cannot spoof a client, a loopback exemption, or the origin
	 *  allowlist). A loopback peer that nevertheless carries forwarded
	 *  headers is an UNDECLARED proxy: only a proxy adds XFF/XFP/XFH, and
	 *  handing it the loopback exemption would admit every remote client it
	 *  fronts. Such a peer resolves as "" (non-loopback → a session is
	 *  required), failing closed until the operator lists the proxy in the
	 *  trustedProxies config. Direct loopback clients (CLI, local UI) never
	 *  send forwarded headers and keep the exemption. */
	clientAddress(req: Request, remoteAddress: string | null | undefined): string {
		const peer = remoteAddress ?? "";
		if (!isTrustedProxy(peer, this.#trustedProxies)) {
			if (
				peerIsLoopback(peer) &&
				(req.headers.has("x-forwarded-for") ||
					req.headers.has("x-forwarded-proto") ||
					req.headers.has("x-forwarded-host"))
			) {
				return "";
			}
			return peer;
		}
		const xff = req.headers.get("x-forwarded-for");
		if (xff !== null) {
			// The FIRST hop is the original client (every later hop was added
			// by a proxy). A peer that is trusted enough to forward headers is
			// trusted to place that hop first; later hops are attacker
			// controlled and never consulted.
			const first = xff.split(",")[0]?.trim() ?? "";
			if (first !== "") return first;
		}
		return remoteAddress ?? "";
	}

	/** Parsed request scheme: the socket's own, replaced by X-Forwarded-Proto
	 *  only when the direct peer is a trusted proxy (forwarded values from
	 *  untrusted peers are ignored). Unknown/empty → "http" (a proxy that
	 *  forwards https must say so; nothing trusts an absent header). */
	clientProto(req: Request, remoteAddress: string | null | undefined): string {
		if (!isTrustedProxy(remoteAddress, this.#trustedProxies)) {
			return requestUrlProto(req);
		}
		const xfp = req.headers.get("x-forwarded-proto");
		if (xfp !== null && xfp !== "") {
			const first = xfp.split(",")[0]?.trim().toLowerCase() ?? "";
			if (first === "https" || first === "http") return first;
		}
		return requestUrlProto(req);
	}

	/** Non-loopback clients must hold a live session when auth is enabled;
	 *  loopback clients (and the disabled state) are admitted with null.
	 *  Callers pass the EFFECTIVE client address (clientAddress, the XFF
	 *  first hop when the peer is trusted); authenticate never re-reads
	 *  forwarded headers itself. */
	authenticate(req: Request, effectiveClient: string): AuthenticatedSession | null {
		if (!this.enabled) return null;
		if (peerIsLoopback(effectiveClient)) return null; // CLI loopback precedent
		return this.#store.authenticate(req);
	}

	/** True iff the presented X-Omp-Csrf matches the session's csrfHash. */
	requireCsrf(req: Request, session: AuthenticatedSession): boolean {
		return this.#store.requireCsrf(req, session);
	}

	/** Origin/Referer allowlist check with the loopback-dev exception. */
	checkOrigin(req: Request): boolean {
		return this.#store.checkOrigin(req, this.#allowedOrigins);
	}
}

/** Loopback peer test for a socket address: 127.0.0.0/8, ::1, and IPv4-mapped
 *  IPv6 of the same (strict numeric parts, same rule as the daemon R14 gate). */
export function isLoopbackIp(address: string | null | undefined): boolean {
	if (address === null || address === undefined) return false;
	const a = address.toLowerCase();
	if (a === "::1" || a.startsWith("::ffff:127.")) return true;
	if (!a.startsWith("127.")) return false;
	// Every dotted part must be numeric; "127.a.b.c" resolves off-loopback.
	return a.split(".").every((part) => /^[0-9]{1,3}$/.test(part) && Number(part) <= 255);
}

export function peerIsLoopback(address: string | null | undefined): boolean {
	return isLoopbackIp(address);
}

/** Scheme the request actually arrived on (the socket's own; Bun reports
 *  http:// on its plain listen, including a TLS-terminating proxy's
 *  loopback side). */
function requestUrlProto(req: Request): string {
	try {
		return new URL(req.url).protocol.replace(/:$/, "").toLowerCase();
	} catch {
		return "http";
	}
}

export { BrowserAuthError };
