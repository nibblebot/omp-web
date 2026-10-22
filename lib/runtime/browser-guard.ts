/**
 * Browser-request guard for loopback peers (FEDGE-02). The loopback exemption
 * admits every request from 127.0.0.0/8 and ::1 without a session or token,
 * but a page the user visits can reach a loopback listener through the browser
 * (DNS rebinding, a cross-site POST, or a cross-site WebSocket dial, which no
 * CORS preflight gates). A browser marks such a request with a foreign Host,
 * Origin, or Sec-Fetch-Site, and it is refused here. Header-less callers (the
 * CLI, scripts) send none of these headers and pass.
 *
 * Shared by the fleet edge and the standalone session's `/ws` upgrade.
 */

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

/** True for the name `localhost` or a loopback IP (IPv6 literals arrive bracketed). */
export function isLoopbackHostname(hostname: string): boolean {
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
