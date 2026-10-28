import { RECONNECT_BACKOFF_MAX_MS, RECONNECT_BACKOFF_MIN_MS } from "./callback-protocol";
import { parseClientCommand } from "./client-command";
import { commandTooLargeMessage, MAX_COMMAND_BYTES, utf8ByteLength } from "./command-limits";
import type { ClientCommand, ServerFrame } from "./protocol";

/**
 * The browser socket (OMP_PROTO 6): the one connection every client holds,
 * a browser to the fleet edge (H1), the `omp-web ui` forwarder, or a direct
 * client to a standalone `omp-web session` (H3). Pure: shared by the edge,
 * the session, the web client, the profile harness and the design system.
 *
 * Route: `GET /ws`, same origin, upgraded to a WebSocket. Text messages only
 * (a binary message is a protocol violation), no per-message deflate. Query:
 *
 *   client=<clientId>  page-scoped id; keys the server's replay ring across
 *                      reconnects (absent = anonymous, no resume state kept)
 *   after=<seq>        last seq the client received (absent = fresh priming)
 *   proto=<OMP_PROTO>  required; a server speaking another proto closes 4426
 *   token=<bearer>     only where the page URL carries one (browsers cannot
 *                      set Authorization on a WebSocket)
 *
 * Server to client, one JSON object per message:
 *
 *   {"seq":N,"frame":<ServerFrame>}       sequenced frame (ring/priming seq)
 *   {"frame":<ServerFrame>}               unsequenced frame
 *   {"ping":<epoch ms>}                   keepalive, every CLIENT_KEEPALIVE_MS idle
 *   {"ack":"<id>"}                        command accepted (was HTTP 202)
 *   {"nack":"<id>","status":S,"error":E}  command refused (was HTTP 400/413/429/...)
 *
 * The frame member is spliced from the frame's own JSON text, never
 * re-stringified, so a relayed session frame crosses the server unparsed.
 * Answers still arrive as id-keyed frames (`call_result`, `attach_result`)
 * routed only to the originating client.
 *
 * Client to server: `{"cmd":<ClientCommand>}`. Every command carries an id;
 * a re-send with the same id inside COMMAND_DEDUP_WINDOW_MS is acked again
 * and replays the recorded answer, never re-dispatches.
 *
 * Resume (fleet edge, additive under OMP_PROTO 6): a dropped named client
 * (`client` query) keeps its session channel parked for the reclaim grace
 * (not after a 1000/1001 close; the web's own redial closes BROWSER_REDIAL_CLOSE);
 * the session holds the ringed deltas meanwhile (stream_pause) and the edge's
 * replay ring holds what arrived before. A returning socket
 * dials with `after`, and the client's re-attach is `{"type":"attach",
 * "workspaceId":W,"resume":true}`. If the ring still holds everything after
 * `after`, the session pair is unchanged and no re-prime frame (hello_ok,
 * attached, history, available_commands, stream_reset) went by that the
 * client missed, the answer is `attach_result` with `resumed:true`: the ring
 * replay (sent at open, before the answer) is the whole catch-up, and no
 * priming, `history` or `state` follows. Otherwise the attach is an ordinary
 * one that primes; an older server ignores `resume`, an older client never
 * sends it. A standalone session's own listener has no attach command and
 * always primes on open.
 *
 * Close codes: 4000 + an HTTP-like status, reason `<kind>: <message>`
 * (the callbackCloseFor scheme). 1000/1001 are ordinary closes.
 */

/**
 * Close code a client sends when it closes its own socket to dial again at
 * once (silence deadline, a newer dial superseding it). A server that keeps
 * per-client resume state keeps it for this close, like for a dropped
 * connection (1006) or its own 4503; a plain 1000 or 1001 (page unloading) is a
 * client that is done, so the server releases what it held for it.
 */
export const BROWSER_REDIAL_CLOSE = 4408;

/** Upgrade route of the browser socket on the fleet, the forwarder and a standalone session. */
export const BROWSER_SOCKET_PATH = "/ws";

/** Slack above MAX_COMMAND_BYTES for the `{"cmd":...}` envelope. */
const ENVELOPE_SLACK_BYTES = 64 * 1024;
/**
 * Server `maxPayloadLength` for client messages. Above MAX_COMMAND_BYTES so an
 * oversize command is still read and answered with nack 413 instead of a
 * socket close; the web refuses a command over the cap before sending.
 */
export const BROWSER_SOCKET_MAX_PAYLOAD_BYTES = MAX_COMMAND_BYTES + ENVELOPE_SLACK_BYTES;

// --- Query ---------------------------------------------------------------------

export interface BrowserSocketParams {
	/** Page-scoped client id; null = anonymous (no ring kept across reconnects). */
	clientId: string | null;
	/** Last seq the client received; null = fresh priming. */
	after: number | null;
	/** OMP_PROTO the client speaks; null when absent. */
	proto: number | null;
	/** Bearer token from the query, for off-loopback clients that cannot set headers. */
	token: string | null;
}

/** Query string (no leading `?`) for a browser socket dial. */
export function browserSocketQuery(params: BrowserSocketParams): string {
	const query = new URLSearchParams();
	if (params.clientId !== null) query.set("client", params.clientId);
	if (params.after !== null) query.set("after", String(params.after));
	if (params.proto !== null) query.set("proto", String(params.proto));
	if (params.token !== null) query.set("token", params.token);
	return query.toString();
}

/**
 * `ws:`/`wss:` URL of the browser socket on `origin` (an http(s) origin such
 * as `location.origin` or a fleet base URL).
 */
export function browserSocketUrl(origin: string, params: BrowserSocketParams): string {
	const url = new URL(BROWSER_SOCKET_PATH, origin);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.search = browserSocketQuery(params);
	return url.toString();
}

/** Non-negative safe integer from a query value, else null. */
function queryInteger(value: string | null): number | null {
	if (value === null || !/^\d+$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : null;
}

/**
 * Read the dial parameters from an upgrade request's query. Malformed `after`
 * or `proto` read as absent: a bad resume point degrades to fresh priming,
 * a bad proto to a 4426 refusal.
 */
export function parseBrowserSocketParams(search: URLSearchParams): BrowserSocketParams {
	const client = search.get("client");
	return {
		clientId: client === null || client === "" ? null : client,
		after: queryInteger(search.get("after")),
		proto: queryInteger(search.get("proto")),
		token: search.get("token"),
	};
}

// --- Server to client ------------------------------------------------------------

/**
 * Sequenced frame message spliced around the frame's JSON text. `frameJson`
 * must be one complete JSON value (a serialized ServerFrame, or a relayed
 * session frame the caller already parsed once).
 */
export function seqFrameMessage(seq: number, frameJson: string): string {
	return `{"seq":${seq},"frame":${frameJson}}`;
}

/** Unsequenced frame message spliced around the frame's JSON text. */
export function frameMessage(frameJson: string): string {
	return `{"frame":${frameJson}}`;
}

/** Keepalive message carrying the server's epoch ms. */
export function pingMessage(at: number): string {
	return `{"ping":${at}}`;
}

/** Command accepted. */
export function ackMessage(id: string): string {
	return `{"ack":${JSON.stringify(id)}}`;
}

/** Command refused with an HTTP-like status (400, 409, 413, 429, 503, ...). */
export function nackMessage(id: string, status: number, error: string): string {
	return JSON.stringify({ nack: id, status, error });
}

export type ServerMessage =
	| { kind: "frame"; seq: number | null; frame: ServerFrame }
	| { kind: "ping"; at: number }
	| { kind: "ack"; id: string }
	| { kind: "nack"; id: string; status: number; error: string };

/**
 * JSON-parse one text message into a plain object, or null for a binary
 * message, invalid JSON, or a JSON value that is not an object.
 */
function parseObjectMessage(data: unknown): object | null {
	if (typeof data !== "string") return null;
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch {
		return null;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/**
 * Parse one server message (untrusted). Returns null for anything that is not
 * a text message of a known shape; the client closes 4400 on null. A frame
 * must be an object with a string `type`; its variant is not validated here.
 */
export function parseServerMessage(data: unknown): ServerMessage | null {
	const message = parseObjectMessage(data);
	if (message === null) return null;
	if ("frame" in message) {
		const { frame } = message;
		if (typeof frame !== "object" || frame === null || !("type" in frame)) return null;
		if (typeof frame.type !== "string") return null;
		// Shape beyond `type` is the consumer's: frames are the server's own serialized ServerFrames.
		const typed = frame as ServerFrame;
		if (!("seq" in message)) return { kind: "frame", seq: null, frame: typed };
		const { seq } = message;
		if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
		return { kind: "frame", seq, frame: typed };
	}
	if ("ping" in message) {
		const { ping } = message;
		return typeof ping === "number" && Number.isFinite(ping) ? { kind: "ping", at: ping } : null;
	}
	if ("ack" in message) {
		const { ack } = message;
		return typeof ack === "string" ? { kind: "ack", id: ack } : null;
	}
	if ("nack" in message && "status" in message) {
		const { nack, status } = message;
		if (typeof nack !== "string" || typeof status !== "number" || !Number.isInteger(status))
			return null;
		const error =
			"error" in message && typeof message.error === "string"
				? message.error
				: `refused (${status})`;
		return { kind: "nack", id: nack, status, error };
	}
	return null;
}

// --- Client to server ------------------------------------------------------------

/** One command as a client message. */
export function commandMessage(command: ClientCommand): string {
	return JSON.stringify({ cmd: command });
}

/** UTF-8 bytes of `{"cmd":` plus the closing `}` around a command. */
const COMMAND_ENVELOPE_BYTES = 8;

/**
 * UTF-8 bytes of the command JSON inside a {@link commandMessage} text (the
 * message minus its envelope), counted without a payload-sized copy. This is
 * the size the server judges against MAX_COMMAND_BYTES, so the client encodes
 * a command once and reuses the text for both the check and the send.
 */
export function commandMessageBytes(message: string): number {
	return utf8ByteLength(message) - COMMAND_ENVELOPE_BYTES;
}

export type ClientMessage =
	| {
			ok: true;
			/** Shape-checked by parseClientCommand; method membership is the dispatcher's. */
			command: ClientCommand;
			/** UTF-8 bytes of the command's JSON (the message minus its envelope), as commandBytes counts it. */
			bytes: number;
	  }
	| {
			ok: false;
			/** The command id when one could be read, so the refusal is a nack; null = protocol violation (close 4400). */
			id: string | null;
			status: number;
			error: string;
	  };

/**
 * Parse one client message (untrusted). `bytes` is the message's UTF-8 length
 * as the server received it (Bun hands strings; the caller measures with
 * Buffer.byteLength). A binary message, non-JSON, a message with no `cmd`
 * object, or a command without a string id is a protocol violation (id null).
 * A command over MAX_COMMAND_BYTES is nacked 413; any other shape
 * parseClientCommand refuses is nacked 400.
 */
export function parseClientMessage(data: unknown, bytes: number): ClientMessage {
	const message = parseObjectMessage(data);
	if (message === null) {
		return {
			ok: false,
			id: null,
			status: 400,
			error: "message must be one JSON object in a text frame",
		};
	}
	const raw = "cmd" in message ? message.cmd : undefined;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, id: null, status: 400, error: 'message must be {"cmd":<command>}' };
	}
	const id = "id" in raw ? raw.id : undefined;
	if (typeof id !== "string" || id === "") {
		return { ok: false, id: null, status: 400, error: "command requires a string id" };
	}
	const commandBytes = bytes - COMMAND_ENVELOPE_BYTES;
	if (commandBytes > MAX_COMMAND_BYTES) {
		return {
			ok: false,
			id,
			status: 413,
			error: commandTooLargeMessage(commandBytes, MAX_COMMAND_BYTES),
		};
	}
	try {
		return { ok: true, command: parseClientCommand(raw), bytes: commandBytes };
	} catch (err) {
		return { ok: false, id, status: 400, error: err instanceof Error ? err.message : String(err) };
	}
}

// --- Close codes -----------------------------------------------------------------

/** Typed reasons a browser socket closes. Status = close code - 4000. */
export const BROWSER_CLOSE = {
	/** Binary, malformed, or otherwise off-contract message. */
	protocol_violation: 4400,
	/** No or expired credential; the client shows sign-in. */
	unauthorized: 4401,
	/** Origin refused (cross-site WebSocket hijacking guard). */
	forbidden: 4403,
	/** Client and server speak different OMP_PROTO; the client reloads. */
	proto_mismatch: 4426,
	/** Slow consumer or unavailable upstream; the client resumes with `after`. */
	slow_consumer: 4503,
} as const;

export type BrowserCloseKind = keyof typeof BROWSER_CLOSE;

const CLOSE_KINDS: Record<number, BrowserCloseKind> = Object.fromEntries(
	Object.entries(BROWSER_CLOSE).map(([kind, code]) => [code, kind as BrowserCloseKind]),
);

/** RFC 6455 caps a close reason at 123 UTF-8 bytes. */
const CLOSE_REASON_MAX_BYTES = 123;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** `text` cut to `max` UTF-8 bytes without splitting a character. */
function cutUtf8(text: string, max: number): string {
	const bytes = utf8.encode(text);
	if (bytes.byteLength <= max) return text;
	return utf8Decoder.decode(bytes.subarray(0, max)).replace(/\uFFFD+$/, "");
}

/** Close code and reason for a typed close: reason `<kind>: <message>`, cut to 123 bytes. */
export function browserCloseFor(
	kind: BrowserCloseKind,
	message: string,
): { code: number; reason: string } {
	return {
		code: BROWSER_CLOSE[kind],
		reason: cutUtf8(`${kind}: ${message}`, CLOSE_REASON_MAX_BYTES),
	};
}

/**
 * Typed close a code stands for, or null for an ordinary or unknown close
 * (1000, 1001, 1006, an unlisted 4xxx). The message is the reason after
 * `<kind>: `, or the whole reason when it has no such prefix.
 */
export function browserCloseFromCode(
	code: number,
	reason: string,
): { kind: BrowserCloseKind; message: string } | null {
	const kind = CLOSE_KINDS[code];
	if (kind === undefined) return null;
	const prefix = `${kind}: `;
	return { kind, message: reason.startsWith(prefix) ? reason.slice(prefix.length) : reason };
}

// --- Reconnect -------------------------------------------------------------------

/**
 * Jittered reconnect delay for the `attempt`th consecutive failed dial
 * (0-based): exponential from RECONNECT_BACKOFF_MIN_MS, capped at
 * RECONNECT_BACKOFF_MAX_MS, uniform in [delay/2, delay]. Clients reset the
 * attempt count once a socket delivers its first message.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
	const ceiling = Math.min(
		RECONNECT_BACKOFF_MAX_MS,
		RECONNECT_BACKOFF_MIN_MS * 2 ** Math.max(0, attempt),
	);
	return Math.round(ceiling / 2 + random() * (ceiling / 2));
}
