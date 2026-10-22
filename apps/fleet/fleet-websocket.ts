/**
 * The fleet's one Bun `websocket` handler. Two socket kinds share the server
 * (Bun's websocket config is server-wide), told apart by `ws.data.kind`:
 *
 *   - "callback": a session's pair socket (`/callback/ws`), owned by the
 *     DaemonTransportRegistry.
 *   - "browser": a client's `/ws` socket (OMP_PROTO 5), owned by the FleetEdge.
 *
 * The server-wide limits are the union of both kinds' needs:
 *
 *   - `maxPayloadLength` takes the browser socket's cap
 *     (BROWSER_SOCKET_MAX_PAYLOAD_BYTES, above MAX_COMMAND_BYTES so an oversize
 *     command is read and nacked 413 instead of closing the socket). The
 *     pair's own, smaller per-message cap (CALLBACK_WS_MAX_PAYLOAD_BYTES) is
 *     enforced in code by the transport, with the same 1009 close Bun sends.
 *   - `backpressureLimit` sits above everything either kind lets accumulate:
 *     the edge closes a browser socket past CLIENT_BACKPRESSURE_BYTES before a
 *     send (so at most that plus one maximum message is ever buffered), and the
 *     transport's send gate keeps a pair far below it. With
 *     `closeOnBackpressureLimit` false and the limit never reached, Bun never
 *     drops or closes on its own: every drop is an explicit, typed close.
 *   - `perMessageDeflate` stays off (text frames are sent as is, and the
 *     frame header sizes the edge's drain accounting assumes are uncompressed).
 *   - `idleTimeout` (with Bun's default `sendPings`) reaps a dead peer of
 *     either kind; it is far above the clients' silence deadlines, which
 *     decide first.
 */

import type { ServerWebSocket, WebSocketHandler } from "bun";
import { BROWSER_SOCKET_MAX_PAYLOAD_BYTES } from "#lib/wire/browser-socket";
import { CLIENT_BACKPRESSURE_BYTES } from "#lib/wire/protocol";
import type { CallbackSocketData, DaemonTransportRegistry } from "./daemon-transport";
import type { BrowserSocketData, FleetEdge } from "./edge";

/** Every `ws.data` shape the fleet's Bun.serve hands its `websocket` handler. */
export type FleetSocketData = CallbackSocketData | BrowserSocketData;

/** Bun's per-socket send-buffer ceiling: the browser cap plus one maximum message, with headroom. */
const WS_BACKPRESSURE_LIMIT_BYTES =
	2 * (CLIENT_BACKPRESSURE_BYTES + BROWSER_SOCKET_MAX_PAYLOAD_BYTES);
/** Bun's WebSocket idle timeout (seconds; any frame from the peer, a pong included, resets it). */
const WS_IDLE_TIMEOUT_S = 120;

function isBrowserSocket(
	ws: ServerWebSocket<FleetSocketData>,
): ws is ServerWebSocket<BrowserSocketData> {
	return ws.data.kind === "browser";
}

/**
 * Compose the callback transport's and the edge's socket handlers into the
 * server's `websocket`. Without a transport (an edge-only server) no
 * callback socket can exist, so only the browser kind is served.
 */
export function fleetWebSocket(
	transport: DaemonTransportRegistry | undefined,
	edge: FleetEdge,
): WebSocketHandler<FleetSocketData> {
	const pair = transport?.websocket;
	return {
		maxPayloadLength: BROWSER_SOCKET_MAX_PAYLOAD_BYTES,
		perMessageDeflate: false,
		backpressureLimit: WS_BACKPRESSURE_LIMIT_BYTES,
		closeOnBackpressureLimit: false,
		idleTimeout: WS_IDLE_TIMEOUT_S,
		open: (ws) => {
			if (isBrowserSocket(ws)) edge.onBrowserOpen(ws);
			else pair?.open?.(ws as ServerWebSocket<CallbackSocketData>);
		},
		message: (ws, message) => {
			if (isBrowserSocket(ws)) edge.onBrowserMessage(ws, message);
			else pair?.message?.(ws as ServerWebSocket<CallbackSocketData>, message);
		},
		drain: (ws) => {
			if (isBrowserSocket(ws)) edge.onBrowserDrain(ws);
			else pair?.drain?.(ws as ServerWebSocket<CallbackSocketData>);
		},
		close: (ws, code, reason) => {
			if (isBrowserSocket(ws)) edge.onBrowserClose(ws);
			else pair?.close?.(ws as ServerWebSocket<CallbackSocketData>, code, reason);
		},
	};
}
