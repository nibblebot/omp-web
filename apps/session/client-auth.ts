import { createHash, timingSafeEqual } from "node:crypto";
import { type BrowserSocketParams, browserCloseFor } from "#lib/wire/browser-socket";
import { OMP_PROTO } from "#lib/wire/protocol";

/**
 * R14 gate of the standalone session's listener, pure so every refusal is
 * testable without a non-loopback peer. Loopback peers are exempt; a daemon
 * started without a token is open (it refuses to bind off-loopback without
 * one); otherwise the peer must present the token.
 */

/**
 * Constant-time token check: both sides are hashed to fixed-size digests
 * first, so neither the comparison nor a length mismatch leaks timing.
 */
export function tokenOk(presented: string, token: string): boolean {
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(token).digest();
	return timingSafeEqual(a, b);
}

/**
 * Authorization header check: the scheme is case-insensitive (`bearer`/
 * `Bearer`), but the token value is compared EXACTLY (regression: the whole
 * header used to be lowercased, accepting wrong-case tokens).
 */
export function bearerHeaderOk(header: string | null, token: string): boolean {
	if (header === null) return false;
	return header.slice(0, 7).toLowerCase() === "bearer " && tokenOk(header.slice(7), token);
}

export interface ClientCredentials {
	/** True when the socket peer address is loopback (127.0.0.0/8, ::1). */
	loopback: boolean;
	/** The daemon's token; undefined = none configured. */
	token: string | undefined;
	/** The request's Authorization header. */
	authorization: string | null;
	/** `browserRequestAllowed` of the request: no foreign Host, Origin or Sec-Fetch-Site. Judged for loopback peers only. */
	browserAllowed: boolean;
}

/** Gate for every plain HTTP route: loopback is exempt, off-loopback needs the bearer header. */
export function httpAuthorized({ loopback, token, authorization }: ClientCredentials): boolean {
	if (loopback) return true;
	if (!token) return true;
	return bearerHeaderOk(authorization, token);
}

/**
 * Gate for the browser socket: the plain-route rule, plus the bearer in the
 * `token` query param because a browser cannot set Authorization on a
 * WebSocket.
 */
export function socketAuthorized(
	credentials: ClientCredentials,
	params: BrowserSocketParams,
): boolean {
	if (httpAuthorized(credentials)) return true;
	return (
		params.token !== null &&
		credentials.token !== undefined &&
		tokenOk(params.token, credentials.token)
	);
}

/**
 * Typed close for a dial the session refuses, or null to accept it. A
 * browser cannot read a non-101 status, so a refusal is delivered by
 * upgrading and closing at once: 4401 for a missing or wrong token, 4403 for a
 * loopback dial a browser page made from a foreign site (loopback is exempt
 * from the token, so only the Host/Origin/Sec-Fetch-Site guard stands between
 * a visited page and the session), 4426 for a missing or different `proto`.
 * Auth is judged first, so an unauthenticated peer learns nothing else.
 */
export function socketRefusal(
	credentials: ClientCredentials,
	params: BrowserSocketParams,
): { code: number; reason: string } | null {
	if (!socketAuthorized(credentials, params)) {
		return browserCloseFor("unauthorized", "missing or wrong bearer token");
	}
	if (credentials.loopback && !credentials.browserAllowed) {
		return browserCloseFor(
			"forbidden",
			"foreign Host, Origin or Sec-Fetch-Site on a loopback dial",
		);
	}
	if (params.proto !== OMP_PROTO) {
		return browserCloseFor(
			"proto_mismatch",
			`this session speaks OMP_PROTO ${OMP_PROTO}, the client sent ${params.proto ?? "none"}`,
		);
	}
	return null;
}
