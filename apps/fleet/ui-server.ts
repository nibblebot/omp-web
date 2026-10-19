/**
 * UI daemon for the split setup (`omp-web ui`): serves the static UI and
 * reverse-proxies the data routes (/events, /command, /ctl, /auth, /callback) to the
 * control plane on loopback. The control plane runs with serveUi off, so
 * this process is the only one that answers for static paths.
 *
 * Forwarded headers: every proxied request gets the observed socket peer
 * appended to X-Forwarded-For (X-Forwarded-Proto and X-Forwarded-Host are set
 * when absent). The control plane's auth gate only honors forwarded headers
 * from peers it trusts, and a loopback peer carrying them resolves as
 * non-loopback (fleet-auth-gate.ts clientAddress), so this hop never launders
 * remote clients into the loopback exemption.
 *
 * Streaming: request and response bodies pass through unbuffered, so SSE
 * flows event by event (idleTimeout is 0). A client disconnect aborts the
 * upstream fetch, so the control plane sees its stream close. Redirects are
 * returned, not followed. An unreachable control plane answers 502 JSON,
 * which the web client maps to its fleet-unreachable notice.
 *
 * Always binds 127.0.0.1; external exposure is the operator's reverse proxy.
 *
 * The proxy strips the browser's Host, so the control plane cannot see it. The
 * guard (browser-guard.ts) therefore refuses a foreign Host, Origin, or
 * Sec-Fetch-Site here, before proxying (FEDGE-02). `browserOrigin` is the
 * configured public origin admitted alongside loopback.
 */

import { browserRequestAllowed, PRE_AUTH_IDLE_TIMEOUT_S } from "./browser-guard";
import { serveStaticUi } from "./static-ui";

export const DEFAULT_UI_PORT = 4723;

export interface UiServer {
	readonly port: number;
	readonly controlPort: number;
	close(): Promise<void>;
}

const LOOPBACK = "127.0.0.1";
/** Data routes proxied to the control plane: the exact path or anything under it. */
const PROXIED_PATH = /^\/(events|command|ctl|auth|callback)(\/|$)/;
/** Hop-by-hop headers (RFC 7230 6.1) are per-connection and never forwarded. */
const HOP_BY_HOP: Record<string, true> = {
	connection: true,
	"keep-alive": true,
	"proxy-authenticate": true,
	"proxy-authorization": true,
	"proxy-connection": true,
	te: true,
	trailer: true,
	"transfer-encoding": true,
	upgrade: true,
};

export function startUiServer(opts: {
	port?: number;
	controlPort: number;
	browserOrigin?: string;
}): UiServer {
	const { controlPort } = opts;
	const server = Bun.serve({
		hostname: LOOPBACK,
		port: opts.port ?? DEFAULT_UI_PORT,
		// SSE responses are long-lived and quiet between keepalive pings;
		// Bun's default idle timeout would kill them.
		idleTimeout: 0,
		fetch: (req, srv) => {
			// /auth/* gets the pre-auth idle window (FEDGE-11); SSE stays on idleTimeout 0.
			if (new URL(req.url).pathname.startsWith("/auth/")) srv.timeout(req, PRE_AUTH_IDLE_TIMEOUT_S);
			return route(req, srv.requestIP(req)?.address, controlPort, opts.browserOrigin);
		},
	});
	return {
		port: server.port!,
		controlPort,
		close: () => server.stop(true),
	};
}

async function route(
	req: Request,
	peer: string | undefined,
	controlPort: number,
	browserOrigin: string | undefined,
): Promise<Response> {
	const path = new URL(req.url).pathname;
	if (!PROXIED_PATH.test(path)) return serveStaticUi(path);
	if (!browserRequestAllowed(req, browserOrigin)) {
		return Response.json({ error: "forbidden" }, { status: 403 });
	}
	return proxy(req, peer, controlPort);
}

async function proxy(
	req: Request,
	peer: string | undefined,
	controlPort: number,
): Promise<Response> {
	const url = new URL(req.url);
	const headers = new Headers();
	for (const [name, value] of req.headers) {
		if (Object.hasOwn(HOP_BY_HOP, name) || name === "host") continue;
		headers.append(name, value);
	}
	if (peer !== undefined) {
		const prior = req.headers.get("x-forwarded-for");
		headers.set("x-forwarded-for", prior ? `${prior}, ${peer}` : peer);
	}
	if (!headers.has("x-forwarded-proto")) headers.set("x-forwarded-proto", "http");
	const host = req.headers.get("host");
	if (host !== null && !headers.has("x-forwarded-host")) headers.set("x-forwarded-host", host);

	const hasBody = req.method !== "GET" && req.method !== "HEAD";
	try {
		const upstream = await fetch(`http://${LOOPBACK}:${controlPort}${url.pathname}${url.search}`, {
			method: req.method,
			headers,
			body: hasBody ? req.body : undefined,
			redirect: "manual",
			signal: req.signal,
		});
		const responseHeaders = new Headers();
		for (const [name, value] of upstream.headers) {
			// fetch may have decoded the body, so the upstream length and coding no longer describe it.
			if (
				Object.hasOwn(HOP_BY_HOP, name) ||
				name === "content-encoding" ||
				name === "content-length"
			)
				continue;
			responseHeaders.append(name, value);
		}
		const contentType = upstream.headers.get("content-type") ?? "";
		if (contentType.startsWith("text/event-stream") && !responseHeaders.has("x-accel-buffering")) {
			responseHeaders.set("x-accel-buffering", "no");
		}
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: responseHeaders,
		});
	} catch {
		// The client went away mid-request: nothing is listening for an answer.
		if (req.signal.aborted) return new Response(null, { status: 499 });
		return Response.json(
			{ error: `omp-web control plane unreachable on :${controlPort}` },
			{ status: 502 },
		);
	}
}
