import {
	ackMessage,
	BROWSER_SOCKET_PATH,
	type BrowserCloseKind,
	browserCloseFor,
	nackMessage,
	parseBrowserSocketParams,
	parseClientMessage,
	pingMessage,
	seqFrameMessage,
} from "#lib/wire/browser-socket";
import {
	CLIENT_KEEPALIVE_MS,
	type ClientCommand,
	DELTA_SEQ_START,
	type ServerFrame,
} from "#lib/wire/protocol";

/**
 * The in-page fleet edge and the browser WebSocket that dials it.
 *
 * Every client connection in the design system is one socket speaking the real
 * wire (lib/wire/browser-socket.ts): `{"seq":N,"frame":F}` frames, `{"cmd":C}`
 * commands answered by `ack`/`nack`, `ping` keepalives, typed closes. The page
 * has no server to dial, so `installFakeSocket` swaps `window.WebSocket` for a
 * constructor that hands the browser socket URL (`/ws` on this origin) to a
 * fake and leaves every other URL to the native class.
 *
 * What the fake edge does, like the real one:
 * - Priming (seq 1..k) on a fresh dial; a dial resuming with `after` at or above
 *   DELTA_SEQ_START replays its live-delta ring instead.
 * - Live deltas (`publish`) take seqs from DELTA_SEQ_START and are ringed;
 *   answers (id-keyed frames) are sequenced too but go only to the asking
 *   client and are not ringed.
 * - A command is acked once; a re-sent id is acked again and replays its
 *   recorded answers, never re-dispatching.
 * - A ping every CLIENT_KEEPALIVE_MS, so the client's silence deadline never fires.
 *
 * The behaviour behind it (roster, handlers) is injected by session.ts.
 */

/** Why a command is refused: becomes `nack` with this HTTP-like status. */
export interface Refusal {
	status: number;
	error: string;
}

/** What the fake edge serves; supplied by session.ts. */
export interface Fleet {
	/** Priming frames for a fresh dial, in wire order (seq 1..k). */
	priming(): ServerFrame[];
	/** Run one command. `answer` sends an id-keyed frame to the asking client, now or later. Return a refusal to nack it. */
	dispatch(cmd: ClientCommand, answer: (frame: ServerFrame) => void): Refusal | null;
}

/**
 * How the next dials end. `serve` opens and serves. `refuse` fails the dial
 * (error, then close 1006, with no `open`). A typed close upgrades and closes
 * at once with that code, as the edge delivers an auth, origin or proto refusal.
 */
export type DialOutcome = "serve" | "refuse" | { close: BrowserCloseKind; message: string };

/** The server's end of one connection: where it writes, and how it hangs up. */
interface Link {
	deliver(text: string): void;
	close(code: number, reason: string): void;
}

/** A client's handle on its connection. */
export interface Connection {
	/** One client-to-server text message. */
	receive(text: string): void;
	/** The client side went away. */
	dispose(): void;
}

const RING_LIMIT = 64;
const DIAL_DELAY_MS = 30;
const encoder = new TextEncoder();

let fleet: Fleet | null = null;
let dialOutcome: DialOutcome = "serve";
let nextLiveSeq = DELTA_SEQ_START;
const links = new Set<Link>();
/** Ringed live deltas, for a resume with `after`. */
const ring: Array<{ seq: number; text: string }> = [];
/** Command id → answer frames (JSON) recorded for a re-sent command. */
const answered = new Map<string, string[]>();

/** Set how every later dial ends (stories reset it to `serve`). */
export function setDialOutcome(outcome: DialOutcome): void {
	dialOutcome = outcome;
}

/** Forget the dedup record, the ring and any dial outcome; connections belong to their clients. */
export function resetFleet(): void {
	dialOutcome = "serve";
	ring.length = 0;
	answered.clear();
}

/** Broadcast one live delta to every connection, and ring it for resumes. */
export function publish(frame: ServerFrame): void {
	const text = seqFrameMessage(nextLiveSeq++, JSON.stringify(frame));
	ring.push({ seq: nextLiveSeq - 1, text });
	if (ring.length > RING_LIMIT) ring.shift();
	for (const link of links) link.deliver(text);
}

function unicast(link: Link, frameJson: string): void {
	link.deliver(seqFrameMessage(nextLiveSeq++, frameJson));
}

function handleCommand(link: Link, text: string): void {
	const message = parseClientMessage(text, encoder.encode(text).byteLength);
	if (!message.ok) {
		if (message.id === null) {
			const close = browserCloseFor("protocol_violation", message.error);
			link.close(close.code, close.reason);
		} else {
			link.deliver(nackMessage(message.id, message.status, message.error));
		}
		return;
	}
	const cmd = message.command;
	const recorded = answered.get(cmd.id);
	if (recorded !== undefined) {
		link.deliver(ackMessage(cmd.id));
		for (const json of recorded) unicast(link, json);
		return;
	}
	if (fleet === null) {
		link.deliver(nackMessage(cmd.id, 503, "design fleet not installed"));
		return;
	}
	const frames: string[] = [];
	answered.set(cmd.id, frames);
	const refusal = fleet.dispatch(cmd, (frame) => {
		const json = JSON.stringify(frame);
		frames.push(json);
		if (links.has(link)) unicast(link, json);
	});
	if (refusal !== null) {
		answered.delete(cmd.id);
		link.deliver(nackMessage(cmd.id, refusal.status, refusal.error));
		return;
	}
	link.deliver(ackMessage(cmd.id));
}

/**
 * Register a connection with the fake edge. `prime` serves a fresh dial's
 * priming (or the ring after `after`); a bare link (the stories' command
 * channel) skips it and only gets answers and live deltas.
 */
export function connectLink(
	link: Link,
	options: { prime: boolean; after?: number | null },
): Connection {
	links.add(link);
	const keepalive = setInterval(() => link.deliver(pingMessage(Date.now())), CLIENT_KEEPALIVE_MS);
	if (options.prime && fleet !== null) {
		const after = options.after ?? null;
		if (after !== null && after >= DELTA_SEQ_START) {
			for (const entry of ring) if (entry.seq > after) link.deliver(entry.text);
		} else {
			fleet.priming().forEach((frame, i) => {
				link.deliver(seqFrameMessage(i + 1, JSON.stringify(frame)));
			});
		}
	}
	return {
		receive: (text) => handleCommand(link, text),
		dispose: () => {
			clearInterval(keepalive);
			links.delete(link);
		},
	};
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** The slice of the browser WebSocket the web client uses, over a fake connection. */
class FakeBrowserSocket extends EventTarget {
	readonly url: string;
	readyState = CONNECTING;
	readonly bufferedAmount = 0;
	readonly extensions = "";
	readonly protocol = "";
	binaryType: BinaryType = "blob";
	onopen: ((ev: Event) => void) | null = null;
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onclose: ((ev: CloseEvent) => void) | null = null;
	onerror: ((ev: Event) => void) | null = null;
	private connection: Connection | null = null;

	constructor(url: URL) {
		super();
		this.url = url.href;
		this.addEventListener("open", (ev) => this.onopen?.(ev));
		this.addEventListener("message", (ev) => this.onmessage?.(ev as MessageEvent));
		this.addEventListener("close", (ev) => this.onclose?.(ev as CloseEvent));
		this.addEventListener("error", (ev) => this.onerror?.(ev));
		const { after } = parseBrowserSocketParams(url.searchParams);
		const outcome = dialOutcome;
		setTimeout(() => this.dial(outcome, after), DIAL_DELAY_MS);
	}

	private dial(outcome: DialOutcome, after: number | null): void {
		if (this.readyState !== CONNECTING) return; // closed before the dial finished
		if (outcome === "refuse") {
			this.dispatchEvent(new Event("error"));
			this.finish(1006, "");
			return;
		}
		this.readyState = OPEN;
		this.dispatchEvent(new Event("open"));
		if (typeof outcome === "object") {
			const close = browserCloseFor(outcome.close, outcome.message);
			this.serverClose(close.code, close.reason);
			return;
		}
		this.connection = connectLink(
			{
				deliver: (text) =>
					queueMicrotask(() => {
						if (this.readyState === OPEN)
							this.dispatchEvent(new MessageEvent("message", { data: text }));
					}),
				close: (code, reason) => this.serverClose(code, reason),
			},
			{ prime: true, after },
		);
	}

	send(data: string): void {
		if (this.readyState === CONNECTING) {
			throw new DOMException("Still in CONNECTING state.", "InvalidStateError");
		}
		if (this.readyState !== OPEN) return;
		queueMicrotask(() => {
			if (this.readyState === OPEN) this.connection?.receive(String(data));
		});
	}

	/** The client closes: the close event follows with the code it gave (1005 when none). */
	close(code?: number, reason?: string): void {
		if (this.readyState === CLOSING || this.readyState === CLOSED) return;
		const wasConnecting = this.readyState === CONNECTING;
		this.readyState = CLOSING;
		this.connection?.dispose();
		this.connection = null;
		setTimeout(() => this.finish(wasConnecting ? 1006 : (code ?? 1005), reason ?? ""), 0);
	}

	/** The server hangs up. */
	private serverClose(code: number, reason: string): void {
		this.connection?.dispose();
		this.connection = null;
		setTimeout(() => this.finish(code, reason), 0);
	}

	private finish(code: number, reason: string): void {
		if (this.readyState === CLOSED) return;
		this.readyState = CLOSED;
		this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code !== 1006 }));
	}
}

/**
 * Serve `behavior` on the browser socket route: `new WebSocket(".../ws?...")`
 * on this origin dials the fake edge; any other URL dials a real socket.
 */
export function installFakeSocket(behavior: Fleet): void {
	fleet = behavior;
	const Native = window.WebSocket;
	const Replacement = function DesignWebSocket(
		url: string | URL,
		protocols?: string | string[],
	): WebSocket {
		const target = new URL(String(url), location.href);
		if (target.host === location.host && target.pathname === BROWSER_SOCKET_PATH) {
			return new FakeBrowserSocket(target) as unknown as WebSocket;
		}
		return new Native(url, protocols);
	} as unknown as typeof WebSocket;
	Object.assign(Replacement, { CONNECTING, OPEN, CLOSING, CLOSED });
	Object.defineProperty(window, "WebSocket", {
		value: Replacement,
		configurable: true,
		writable: true,
	});
}
