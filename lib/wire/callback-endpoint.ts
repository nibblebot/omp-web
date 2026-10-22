import { CALLBACK_WS_PATH } from "./callback-protocol";

/**
 * Where and how a callback client dials the fleet: the pair's WebSocket URL
 * and the proxy it goes through. Shared by the session's FleetCallback and
 * the fleet's `omp-web preflight` probe so both resolve an endpoint the same
 * way. Pure apart from the optional process environment read.
 */

/** Pair WebSocket URL of a callback base URL: http maps to ws, https to wss, any path prefix is kept. */
export function callbackWsUrl(baseUrl: string): string {
	return `${baseUrl.replace(/\/+$/, "").replace(/^http/, "ws")}${CALLBACK_WS_PATH}`;
}

/**
 * Proxy Bun's fetch picks from the environment for `url` (HTTP(S)_PROXY, minus
 * NO_PROXY matches). Bun's WebSocket client ignores the environment, so the
 * dialer resolves it once and passes it explicitly.
 */
export function environmentProxy(
	url: URL,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const secure = url.protocol === "https:";
	const raw = secure ? (env.HTTPS_PROXY ?? env.https_proxy) : (env.HTTP_PROXY ?? env.http_proxy);
	if (raw === undefined || raw === "") return undefined;
	const port = url.port || (secure ? "443" : "80");
	const host = url.hostname.toLowerCase();
	for (const entry of (env.NO_PROXY ?? env.no_proxy ?? "").split(",")) {
		let pattern = entry.trim().toLowerCase();
		if (pattern === "") continue;
		if (pattern === "*") return undefined;
		const withPort = /^(.*):(\d+)$/.exec(pattern);
		if (withPort !== null) {
			if (withPort[2] !== port) continue;
			pattern = withPort[1]!;
		}
		pattern = pattern.replace(/^\*?\./, "");
		if (host === pattern || host.endsWith(`.${pattern}`)) return undefined;
	}
	return raw;
}

/**
 * Throw unless `proxyUrl` is an http/https proxy URL. There is no silent
 * fallback to a direct connection, so an unusable proxy is an error, not a skip.
 */
export function assertCallbackProxy(proxyUrl: string): void {
	let proxy: URL;
	try {
		proxy = new URL(proxyUrl);
	} catch (cause) {
		throw new Error(`invalid callback proxy "${proxyUrl}" (not a URL)`, { cause });
	}
	if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
		throw new Error(
			`unsupported callback proxy scheme "${proxy.protocol}" ("${proxyUrl}"); only http/https proxies are supported and there is no direct fallback`,
		);
	}
}
