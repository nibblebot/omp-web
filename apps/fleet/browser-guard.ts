/**
 * Browser-request guard for loopback peers (FEDGE-02). The loopback exemption
 * admits every request from 127.0.0.0/8 and ::1 without a session, but a page
 * the user visits can reach a loopback listener through the browser (DNS
 * rebinding, or a cross-site POST). A browser marks such a request with a
 * foreign Host, Origin, or Sec-Fetch-Site, and it is refused here. Header-less
 * callers (the CLI, scripts) send none of these headers and pass.
 */

import { isLoopbackIp } from "./fleet-auth-gate";

/** Idle window for /auth/* requests on both listeners; other routes keep Bun's idleTimeout 0 (FEDGE-11). */
export const PRE_AUTH_IDLE_TIMEOUT_S = 10;

/** True for the name `localhost` or a loopback IP (IPv6 literals arrive bracketed). */
function isLoopbackHostname(hostname: string): boolean {
	const bare = hostname.replace(/^\[(.*)\]$/, "$1");
	return bare === "localhost" || isLoopbackIp(bare);
}

/**
 * Whether a request a browser sent on a loopback peer may proceed. The Host
 * must name loopback or the configured browser origin; an Origin must be a
 * loopback http(s) origin or the configured origin; Sec-Fetch-Site must not be
 * cross-site. An unparseable Host, Origin, or configured origin fails closed.
 */
export function browserRequestAllowed(req: Request, browserOrigin: string | undefined): boolean {
	let configured: URL | null = null;
	if (browserOrigin !== undefined && browserOrigin !== "") {
		try {
			configured = new URL(browserOrigin);
		} catch {
			return false;
		}
	}
	const host = req.headers.get("host");
	if (host !== null) {
		let parsedHost: URL;
		try {
			parsedHost = new URL(`http://${host}`);
		} catch {
			return false;
		}
		if (!isLoopbackHostname(parsedHost.hostname) && parsedHost.host !== configured?.host) {
			return false;
		}
	}
	const origin = req.headers.get("origin");
	if (origin !== null) {
		let parsedOrigin: URL;
		try {
			parsedOrigin = new URL(origin);
		} catch {
			return false;
		}
		const loopbackOrigin =
			(parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") &&
			isLoopbackHostname(parsedOrigin.hostname);
		if (!loopbackOrigin && parsedOrigin.origin !== configured?.origin) return false;
	}
	return req.headers.get("sec-fetch-site") !== "cross-site";
}

/** True when the body's media type is application/json (parameters ignored). */
export function isJsonRequest(req: Request): boolean {
	const type = req.headers.get("content-type");
	return type !== null && type.split(";")[0]?.trim().toLowerCase() === "application/json";
}
