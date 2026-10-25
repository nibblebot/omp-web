/**
 * UI server for the split setup (`omp-web ui`): serves the static UI and
 * reverse-proxies the data routes (/ctl, /auth, /callback) to the
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
 * Streaming: request and response bodies pass through unbuffered (idleTimeout
 * is 0). A client disconnect aborts the upstream fetch, so the control plane
 * sees its stream close. Redirects are returned, not followed. An unreachable
 * control plane answers 502 JSON, which the web client maps to its
 * fleet-unreachable notice.
 *
 * WebSocket: a session's pair socket (GET /callback/ws upgrade) and a
 * browser's socket (GET /ws upgrade, OMP_PROTO 6, same path and query
 * upstream) are bridged to the control plane message for message (see
 * BridgeData); the callback pair forwards frames opaquely, text or binary, the
 * browser socket is text only. The upgrade request's end-to-end headers,
 * credentials (Cookie, Authorization) and Origin included, are replayed on the
 * upstream dial with X-Forwarded-For appended like an HTTP request's; a
 * control-plane close (typed refusals are 4xxx) reaches the client intact, and
 * an unreachable control plane closes it with a typed 4503 (a session's
 * `unavailable`, a browser's `slow_consumer`) so it redials. Sends are gated
 * at a 1 MiB high-water mark and the forwarder holds a bounded amount per
 * socket (BRIDGE_MAX_BYTES for a pair, BROWSER_BRIDGE_MAX_BYTES toward the
 * control plane and a high-water mark plus one read chunk toward a browser),
 * so a stuck browser is dropped by the control plane's stall rule and not
 * absorbed here.
 *
 * Always binds 127.0.0.1; external exposure is the operator's reverse proxy.
 *
 * The proxy strips the browser's Host, so the control plane cannot see it. The
 * guard (browser-guard.ts) therefore refuses a foreign Host, Origin, or
 * Sec-Fetch-Site here, before proxying (FEDGE-02). `browserOrigin` is the
 * configured public origin admitted alongside loopback.
 */

import type { Server, ServerWebSocket } from "bun";
import {
	BROWSER_SOCKET_MAX_PAYLOAD_BYTES,
	BROWSER_SOCKET_PATH,
	browserCloseFor,
} from "#lib/wire/browser-socket";
import {
	CALLBACK_WS_MAX_PAYLOAD_BYTES,
	CALLBACK_WS_PATH,
	CALLBACK_WS_SEND_HIGH_WATER_BYTES,
	ENVELOPE_MAX_BYTES,
	PAIR_CREDIT_WINDOW_BYTES,
	callbackCloseFor,
	callbackError,
} from "#lib/wire/callback-protocol";
import { browserRequestAllowed } from "#lib/runtime/browser-guard";
import { PRE_AUTH_IDLE_TIMEOUT_S } from "./browser-guard";
import { serveStaticUi } from "./static-ui";

export const DEFAULT_UI_PORT = 4723;

export interface UiServer {
	readonly port: number;
	readonly controlPort: number;
	close(): Promise<void>;
}

/** What startUiServer's `observeBridge` seam reports for one bridged socket's upstream leg. */
export interface BridgeSample {
	/** Client bytes queued, not yet handed to the upstream client. */
	queuedBytes: number;
	/** The upstream client's send buffer (`bufferedAmount`). */
	upstreamBuffered: number;
	/** The client-facing socket's send buffer (`getBufferedAmount()`). */
	clientBuffered: number;
}

const LOOPBACK = "127.0.0.1";
/** Re-check interval while the upstream's send buffer is above the high-water mark (the Bun client has no drain event). */
const SEND_RECHECK_MS = 10;
/**
 * What the bridge may hold for one session socket (queued plus upstream-buffered)
 * before the pair is closed `retryable`: the pair credit window plus the frame
 * overhead of the upstream's buffer.
 *
 * The window is exact, not an estimate. A session has at most
 * PAIR_CREDIT_WINDOW_BYTES outstanding beyond the credit the control plane
 * granted, and the control plane grants only what its own consumer has
 * processed, which sits behind this bridge. Whatever the session sent and the
 * control plane has not consumed is therefore inside the window, wherever it
 * currently is: the session's socket, the kernel send and receive buffers on
 * both hops (a server socket cannot be paused, and a bridge busy with other
 * hops reads all of it in one pass), this queue, the upstream client's buffer.
 * Nothing about kernel buffer sizes enters the bound. Both ends count the UTF-8
 * length of each text message, so the queue is counted in the window's unit.
 *
 * The slack covers what the window does not: `bufferedAmount` of the upstream
 * client counts WebSocket frame headers (2 to 14 bytes) on top of the payload.
 * An envelope is at least about 150 bytes, so a window holds under 56,000 of
 * them, under 0.5 MiB of headers: one ENVELOPE_MAX_BYTES covers it.
 * A session past the bound ignored the window (or the control plane stopped
 * granting while it kept sending) and fails loudly.
 */
export const BRIDGE_MAX_BYTES = PAIR_CREDIT_WINDOW_BYTES + ENVELOPE_MAX_BYTES;
/** Send high-water mark of a browser socket's legs: the upstream client is paused above it, queued messages wait above it. */
export const BROWSER_BRIDGE_HIGH_WATER_BYTES = 1024 * 1024;
/**
 * What the bridge may hold for one browser socket toward the control plane
 * (queued plus upstream-buffered) before the socket is closed 4503. A server
 * socket cannot be paused, so what a browser sends is read at once; the bound
 * is two maximum command messages, so a command at the size cap (32 MiB) does
 * not starve the next one while it drains. A browser sends commands one user
 * action at a time; past the bound it is flooding and fails loudly (it resumes
 * with the same command ids after the reconnect).
 */
export const BROWSER_BRIDGE_MAX_BYTES = 2 * BROWSER_SOCKET_MAX_PAYLOAD_BYTES;
/**
 * Bun's send-queue cap per client socket (above it `send` drops and returns 0,
 * which closes the socket 4503). The browser leg holds at most its high-water
 * mark plus what the paused upstream client had already read, so this is slack
 * for the largest relayed message; Bun never closes on it by itself.
 */
const SEND_BACKPRESSURE_LIMIT_BYTES = 32 * 1024 * 1024;
/** Bun's WebSocket client with its upgrade-header options; the DOM lib types hide them. */
const BunWebSocket = WebSocket as unknown as new (
	url: string,
	options: Bun.WebSocketOptions,
) => Bun.WebSocket;
/** Data routes proxied to the control plane: the exact path or anything under it. */
const PROXIED_PATH = /^\/(ctl|auth|callback)(\/|$)/;
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

/**
 * One client socket bridged to the control plane: a session's pair socket to
 * /callback/ws, or a browser's socket to /ws (`kind`). The bridge is a
 * transparent message pipe: it neither parses envelopes nor validates them, so
 * refusals (close 4xxx) and everything else pass through. Memory stays
 * bounded both ways: toward the client the upstream client is paused (Bun's
 * client WebSocket `pause()` stops reading its TCP socket, so the control
 * plane's own send buffer fills and its slow-consumer rule applies to the
 * stuck client) while the client-facing socket is above the send high-water
 * mark; the forwarder then holds that mark plus what the paused client had
 * already received (one socket read chunk of messages and the message being
 * assembled), and nothing grows with the stream. Toward the control plane a
 * server socket cannot be paused, so client messages queue in `backlog` and
 * reach the upstream client only while its send buffer is at or below the high-water
 * mark (bridgeFlush: the queue built before the upstream opened drains through
 * the same gate, not in one burst, and the Bun client has no drain event, so a
 * short timer re-checks). New messages queue behind a remaining backlog, so
 * order holds. The socket is closed once queued plus upstream-buffered bytes
 * pass `maxBytes` (a pair: `retryable`; a browser: 4503).
 */
interface BridgeData {
	kind: "callback" | "browser";
	/** Path and query of the upstream dial: the request's own. */
	upstreamTarget: string;
	/** Dial-time refusal: the socket upgrades and closes at once with this (a browser cannot read a non-101 status). */
	refusal: { code: number; reason: string } | null;
	/** Send high-water mark of both legs. */
	highWater: number;
	/** Cap on `backlogBytes` plus the upstream's buffered amount. */
	maxBytes: number;
	/** End-to-end request headers for the upstream dial (credentials included, never logged). */
	upstreamHeaders: Headers;
	upstream: Bun.WebSocket | null;
	/**
	 * Messages from the client not yet handed to the upstream, oldest at
	 * `backlogHead`: everything that arrived before the upstream opened and
	 * whatever the high-water gate in bridgeFlush is holding back.
	 */
	backlog: (string | Buffer)[];
	backlogHead: number;
	/** Bytes in `backlog[backlogHead..]`; with the upstream's buffered amount it is capped at `maxBytes`. */
	backlogBytes: number;
	/** Pending re-check of an upstream send buffer above high water. */
	sendTimer: Timer | null;
	/** Test seam, see startUiServer. */
	observeBridge: ((sample: BridgeSample) => void) | undefined;
	/** The upstream client is paused until the client-facing socket drains. */
	paused: boolean;
	done: boolean;
}

/** Mark the bridge finished and close the upstream with the session's close (codes a client cannot send go without one). */
function endBridge(bridge: BridgeData, code: number, reason: string): void {
	if (bridge.done) return;
	bridge.done = true;
	bridge.backlog = [];
	bridge.backlogHead = 0;
	bridge.backlogBytes = 0;
	if (bridge.sendTimer !== null) {
		clearTimeout(bridge.sendTimer);
		bridge.sendTimer = null;
	}
	try {
		if (code === 1000 || (code >= 3000 && code <= 4999)) bridge.upstream?.close(code, reason);
		else bridge.upstream?.close();
	} catch {
		// The upstream is already closing.
	}
}

/** Close both halves with `code`/`reason` (server-sendable codes only; abnormal ones become 1011). */
function bridgeClose(ws: ServerWebSocket<BridgeData>, code: number, reason: string): void {
	if (ws.data.done) return;
	endBridge(ws.data, code, reason);
	const sendable =
		(code >= 1000 && code <= 1003) ||
		(code >= 1007 && code <= 1014) ||
		(code >= 3000 && code <= 4999);
	ws.close(sendable ? code : 1011, reason);
}

/** Report the bridge's current queue and buffers to the test seam. */
function observe(ws: ServerWebSocket<BridgeData>): void {
	const bridge = ws.data;
	if (bridge.observeBridge === undefined || bridge.upstream === null) return;
	bridge.observeBridge({
		queuedBytes: bridge.backlogBytes,
		upstreamBuffered: bridge.upstream.bufferedAmount,
		clientBuffered: ws.getBufferedAmount(),
	});
}

/** Close the client with the typed code for a forwarder-side failure: a pair's `unavailable`/`retryable`, a browser's 4503. */
function bridgeFail(
	ws: ServerWebSocket<BridgeData>,
	code: "unavailable" | "retryable",
	message: string,
): void {
	const close =
		ws.data.kind === "browser"
			? browserCloseFor("slow_consumer", message)
			: callbackCloseFor(callbackError(code, message));
	bridgeClose(ws, close.code, close.reason);
}

function bridgeOpen(ws: ServerWebSocket<BridgeData>, controlPort: number): void {
	const bridge = ws.data;
	if (bridge.refusal !== null) {
		bridgeClose(ws, bridge.refusal.code, bridge.refusal.reason);
		return;
	}
	let upstream: Bun.WebSocket;
	try {
		upstream = new BunWebSocket(`ws://${LOOPBACK}:${controlPort}${bridge.upstreamTarget}`, {
			headers: Object.fromEntries(bridge.upstreamHeaders),
		});
	} catch {
		bridgeFail(ws, "unavailable", `omp-web control plane unreachable on :${controlPort}`);
		return;
	}
	upstream.binaryType = "arraybuffer";
	bridge.upstream = upstream;
	upstream.addEventListener("open", () => bridgeFlush(ws));
	upstream.addEventListener("message", (event) => {
		if (bridge.done) return;
		const { data } = event as unknown as MessageEvent<string | ArrayBuffer>;
		if (bridge.kind === "browser" && typeof data !== "string") {
			const close = browserCloseFor("protocol_violation", "control plane sent a binary message");
			bridgeClose(ws, close.code, close.reason);
			return;
		}
		// 0 = dropped by Bun: tear the socket down rather than lose a message.
		if (ws.send(data) === 0) {
			bridgeFail(ws, "retryable", "bridge could not deliver a message");
			return;
		}
		observe(ws);
		if (ws.getBufferedAmount() > bridge.highWater && !bridge.paused) {
			bridge.paused = true;
			upstream.pause();
		}
	});
	upstream.addEventListener("error", () => {
		bridgeFail(ws, "unavailable", `omp-web control plane unreachable on :${controlPort}`);
	});
	upstream.addEventListener("close", (event) => {
		// An abnormal drop of a browser's upstream (no close frame) is the control plane going away: 4503, so the browser resumes.
		if (bridge.kind === "browser" && (event.code === 1006 || event.code === 1015)) {
			bridgeFail(ws, "unavailable", `omp-web control plane unreachable on :${controlPort}`);
			return;
		}
		// A close the control plane sent passes through whole, so a typed refusal reaches the client intact.
		bridgeClose(ws, event.code, event.reason);
	});
}

function bridgeMessage(ws: ServerWebSocket<BridgeData>, message: string | Buffer): void {
	const bridge = ws.data;
	const upstream = bridge.upstream;
	if (bridge.done || upstream === null) return;
	if (upstream.readyState !== WebSocket.CONNECTING && upstream.readyState !== WebSocket.OPEN)
		return;
	if (bridge.kind === "browser" && typeof message !== "string") {
		const close = browserCloseFor("protocol_violation", "binary message");
		bridgeClose(ws, close.code, close.reason);
		return;
	}
	const bytes = typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
	// The one socket config serves both routes, so the pair's own cap is enforced here.
	if (bridge.kind === "callback" && bytes > CALLBACK_WS_MAX_PAYLOAD_BYTES) {
		bridgeClose(ws, 1009, "message too big");
		return;
	}
	bridge.backlog.push(message);
	bridge.backlogBytes += bytes;
	if (bridge.backlogBytes + upstream.bufferedAmount > bridge.maxBytes) {
		bridgeFail(ws, "retryable", "bridge upstream backlog exceeded");
		return;
	}
	observe(ws);
	if (upstream.readyState === WebSocket.OPEN) bridgeFlush(ws);
}

/**
 * Hand queued client messages to the open upstream in order while its send
 * buffer is at or below the high-water mark, so neither the pre-open backlog
 * nor a slow control plane turns into one burst. What is left waits in the
 * bounded queue and is retried on a short timer (the Bun client has no drain
 * event). A pair's frames are forwarded opaquely, text or binary; a browser's
 * are text.
 */
function bridgeFlush(ws: ServerWebSocket<BridgeData>): void {
	const bridge = ws.data;
	const upstream = bridge.upstream;
	if (bridge.done || upstream === null || upstream.readyState !== WebSocket.OPEN) return;
	while (bridge.backlogHead < bridge.backlog.length) {
		if (upstream.bufferedAmount > bridge.highWater) break;
		const message = bridge.backlog[bridge.backlogHead]!;
		bridge.backlog[bridge.backlogHead++] = "";
		bridge.backlogBytes -=
			typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
		upstream.send(message);
		observe(ws);
	}
	if (bridge.backlogHead === bridge.backlog.length) {
		bridge.backlog = [];
		bridge.backlogHead = 0;
		return;
	}
	// Drop the sent prefix once it dominates, so a long-lived backlog of small messages stays small.
	if (bridge.backlogHead > 1024 && bridge.backlogHead * 2 > bridge.backlog.length) {
		bridge.backlog = bridge.backlog.slice(bridge.backlogHead);
		bridge.backlogHead = 0;
	}
	if (bridge.sendTimer === null) {
		bridge.sendTimer = setTimeout(() => {
			bridge.sendTimer = null;
			bridgeFlush(ws);
		}, SEND_RECHECK_MS);
	}
}

function bridgeDrain(ws: ServerWebSocket<BridgeData>): void {
	const bridge = ws.data;
	if (!bridge.paused || bridge.done || ws.getBufferedAmount() > bridge.highWater) {
		return;
	}
	bridge.paused = false;
	bridge.upstream?.resume();
}

/**
 * Upgrade a session's /callback/ws or a browser's /ws request and bridge it to
 * the control plane. A `refusal` upgrades and closes at once with that typed
 * close, since a browser cannot read a non-101 status.
 */
function upgradeBridge(
	req: Request,
	srv: Server<BridgeData>,
	peer: string | undefined,
	observeBridge: ((sample: BridgeSample) => void) | undefined,
	variant:
		| { kind: "callback" }
		| { kind: "browser"; refusal: { code: number; reason: string } | null },
): Response | undefined {
	const upstreamHeaders = new Headers();
	for (const [name, value] of forwardedHeaders(req, peer)) {
		if (!name.startsWith("sec-websocket-")) upstreamHeaders.append(name, value);
	}
	const browser = variant.kind === "browser";
	const data: BridgeData = {
		kind: variant.kind,
		upstreamTarget: browser ? `${BROWSER_SOCKET_PATH}${new URL(req.url).search}` : CALLBACK_WS_PATH,
		refusal: browser ? variant.refusal : null,
		highWater: browser ? BROWSER_BRIDGE_HIGH_WATER_BYTES : CALLBACK_WS_SEND_HIGH_WATER_BYTES,
		maxBytes: browser ? BROWSER_BRIDGE_MAX_BYTES : BRIDGE_MAX_BYTES,
		upstreamHeaders,
		upstream: null,
		backlog: [],
		backlogHead: 0,
		backlogBytes: 0,
		sendTimer: null,
		observeBridge,
		paused: false,
		done: false,
	};
	if (srv.upgrade(req, { data })) return undefined;
	return Response.json({ error: "websocket upgrade failed" }, { status: 400 });
}

export function startUiServer(opts: {
	port?: number;
	controlPort: number;
	browserOrigin?: string;
	/** Test seam: sampled on every queued message and after every upstream send. */
	observeBridge?: (sample: BridgeSample) => void;
}): UiServer {
	const { controlPort } = opts;
	const server = Bun.serve<BridgeData>({
		hostname: LOOPBACK,
		port: opts.port ?? DEFAULT_UI_PORT,
		// Quiet streams and sockets (both ping every 15 s) outlive Bun's default idle timeout.
		idleTimeout: 0,
		fetch: (req, srv) => {
			// /auth/* gets the pre-auth idle window (FEDGE-11); sockets stay on idleTimeout 0.
			const { pathname } = new URL(req.url);
			if (pathname.startsWith("/auth/")) srv.timeout(req, PRE_AUTH_IDLE_TIMEOUT_S);
			const peer = srv.requestIP(req)?.address;
			const upgrade = req.headers.get("upgrade")?.toLowerCase() === "websocket";
			if (pathname === CALLBACK_WS_PATH && upgrade) {
				if (!browserRequestAllowed(req, opts.browserOrigin)) {
					return Response.json({ error: "forbidden" }, { status: 403 });
				}
				return upgradeBridge(req, srv, peer, opts.observeBridge, { kind: "callback" });
			}
			if (pathname === BROWSER_SOCKET_PATH) {
				if (!upgrade) {
					return Response.json(
						{ error: "websocket upgrade required" },
						{ status: 426, headers: { upgrade: "websocket" } },
					);
				}
				const refusal = browserRequestAllowed(req, opts.browserOrigin)
					? null
					: browserCloseFor("forbidden", "origin or host not allowed");
				return upgradeBridge(req, srv, peer, opts.observeBridge, { kind: "browser", refusal });
			}
			return route(req, peer, controlPort, opts.browserOrigin);
		},
		websocket: {
			perMessageDeflate: false,
			// One config serves both routes: the browser's cap is the larger; a pair's own cap is enforced in bridgeMessage.
			maxPayloadLength: Math.max(CALLBACK_WS_MAX_PAYLOAD_BYTES, BROWSER_SOCKET_MAX_PAYLOAD_BYTES),
			backpressureLimit: SEND_BACKPRESSURE_LIMIT_BYTES,
			closeOnBackpressureLimit: false,
			open: (ws) => bridgeOpen(ws, controlPort),
			message: bridgeMessage,
			drain: bridgeDrain,
			close: (ws, code, reason) => endBridge(ws.data, code, reason),
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

/** End-to-end request headers for a proxied request: hop-by-hop and Host dropped, forwarded-* stamped. */
function forwardedHeaders(req: Request, peer: string | undefined): Headers {
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
	return headers;
}

async function proxy(
	req: Request,
	peer: string | undefined,
	controlPort: number,
): Promise<Response> {
	const url = new URL(req.url);
	const headers = forwardedHeaders(req, peer);
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
