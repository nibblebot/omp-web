/**
 * Browser-socket client for the session's server tests: dials `GET /ws`
 * (OMP_PROTO 6) the way a direct client does and collects what the session
 * sends. Frames, their seqs, keepalive pings, acks/nacks and the close are all
 * observable; commands go up in-band and settle on their ack/nack.
 *
 * Built on the wire module's own parsers (`parseServerMessage`,
 * `commandMessage`, `browserSocketUrl`), so a framing change breaks these
 * tests the same way it breaks a real client.
 */

import {
	browserCloseFromCode,
	browserSocketUrl,
	commandMessage,
	parseServerMessage,
	type BrowserCloseKind,
} from "#lib/wire/browser-socket";
import { OMP_PROTO, type ClientCommand } from "#lib/wire/protocol";

/** One frame as the session serialized it (the variant is asserted by the test, not typed here). */
export type WireFrame = { type: string; [key: string]: unknown };

/** How a command settled: acked (the old 202) or nacked with an HTTP-like status. */
export type CommandOutcome = { ok: true } | { ok: false; status: number; error: string };

/** How the socket ended: the raw code and reason, and the typed close it stands for. */
export interface SocketClose {
	code: number;
	reason: string;
	kind: BrowserCloseKind | null;
}

export interface BrowserSocketClient {
	/** Every frame received, in arrival order. */
	frames: WireFrame[];
	/** The seq of each frame, parallel to `frames` (null for an unsequenced frame). */
	seqs: Array<number | null>;
	/** Keepalive pings received. */
	pings: number;
	/** Resolves when the socket closes (any side). */
	closed: Promise<SocketClose>;
	/** Send one command and resolve with its ack/nack. */
	command: (command: Record<string, unknown>) => Promise<CommandOutcome>;
	/** Send raw text as one client message (for malformed-message tests). */
	sendRaw: (text: string) => void;
	/** Send one binary message (a protocol violation: the session closes 4400). */
	sendBinary: (bytes: Uint8Array<ArrayBuffer>) => void;
	/** Close the socket from the client side (1000). */
	close: () => void;
}

export interface OpenBrowserSocketOptions {
	/** Resume point: the last seq this page received. */
	after?: number;
	/** Page-scoped client id. */
	clientId?: string;
	/** OMP_PROTO claimed on the dial (default: the current one). `null` omits it. */
	proto?: number | null;
	/** Bearer token for the `token` query param. */
	token?: string;
	/** Extra request headers (Bun's WebSocket accepts them; browsers cannot send any). */
	headers?: Record<string, string>;
}

/** Bun's WebSocket client accepts request headers; the DOM typings do not know the option. */
const HeaderWebSocket = WebSocket as unknown as new (
	url: string,
	options?: { headers: Record<string, string> },
) => WebSocket;

const OPEN_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 15_000;

/** `ws:` URL of a session's browser socket for an http origin. */
export function socketUrlFor(baseUrl: string, options: OpenBrowserSocketOptions = {}): string {
	return browserSocketUrl(baseUrl, {
		clientId: options.clientId ?? null,
		after: options.after ?? null,
		proto: options.proto === undefined ? OMP_PROTO : options.proto,
		token: options.token ?? null,
	});
}

/**
 * Open a browser socket; resolves once the upgrade completes (a dial the
 * session refuses is upgraded and closed at once, so it still resolves; read
 * `closed`). Rejects when the dial itself fails.
 */
export function openBrowserSocket(
	baseUrl: string,
	options: OpenBrowserSocketOptions = {},
): Promise<BrowserSocketClient> {
	const url = socketUrlFor(baseUrl, options);
	const ws = new HeaderWebSocket(
		url,
		options.headers === undefined ? undefined : { headers: options.headers },
	);
	const frames: WireFrame[] = [];
	const seqs: Array<number | null> = [];
	let pings = 0;
	const pending = new Map<string, Array<(outcome: CommandOutcome) => void>>();
	const settle = (id: string, outcome: CommandOutcome): void => {
		pending.get(id)?.shift()?.(outcome);
	};
	const closedWaiter = Promise.withResolvers<SocketClose>();
	const opened = Promise.withResolvers<BrowserSocketClient>();

	const client: BrowserSocketClient = {
		frames,
		seqs,
		get pings() {
			return pings;
		},
		closed: closedWaiter.promise,
		command: (command) => {
			const id = command.id;
			if (typeof id !== "string") throw new Error("command needs a string id");
			return new Promise<CommandOutcome>((resolve, reject) => {
				const timer = setTimeout(
					() =>
						reject(
							new Error(`command ${id} was neither acked nor nacked in ${COMMAND_TIMEOUT_MS}ms`),
						),
					COMMAND_TIMEOUT_MS,
				);
				const waiters = pending.get(id) ?? [];
				waiters.push((outcome) => {
					clearTimeout(timer);
					resolve(outcome);
				});
				pending.set(id, waiters);
				ws.send(commandMessage(command as unknown as ClientCommand));
			});
		},
		sendRaw: (text) => ws.send(text),
		sendBinary: (bytes) => ws.send(bytes),
		close: () => ws.close(1000),
	};

	const timer = setTimeout(
		() => opened.reject(new Error(`browser socket open timed out: ${url}`)),
		OPEN_TIMEOUT_MS,
	);
	ws.addEventListener("open", () => {
		clearTimeout(timer);
		opened.resolve(client);
	});
	ws.addEventListener("error", () => {
		clearTimeout(timer);
		opened.reject(new Error(`browser socket dial failed: ${url}`));
	});
	ws.addEventListener("message", (event) => {
		const message = parseServerMessage(event.data);
		if (message === null)
			throw new Error(`unparseable server message: ${String(event.data).slice(0, 200)}`);
		switch (message.kind) {
			case "frame":
				frames.push(message.frame as unknown as WireFrame);
				seqs.push(message.seq);
				return;
			case "ping":
				pings++;
				return;
			case "ack":
				settle(message.id, { ok: true });
				return;
			case "nack":
				settle(message.id, { ok: false, status: message.status, error: message.error });
				return;
		}
	});
	ws.addEventListener("close", (event) => {
		const typed = browserCloseFromCode(event.code, event.reason);
		closedWaiter.resolve({ code: event.code, reason: event.reason, kind: typed?.kind ?? null });
	});
	return opened.promise;
}

/** A raw TCP dial that speaks just enough WebSocket to stall: it can stop reading. */
export interface RawBrowserSocket {
	/** Send one command (a masked text frame; the command must fit a 16-bit length). */
	sendCommand: (command: Record<string, unknown>) => void;
	/** Frame types read so far (sniffed from each frame's head; the payload is not parsed). */
	types: ReadonlySet<string>;
	/** Stop reading: kernel buffers fill and the session's own send buffer grows. */
	pause: () => void;
	/**
	 * Resume reading and resolve with the close frame the session sends after
	 * whatever it had buffered (`bytes` counts every payload byte read).
	 */
	drainToClose: () => Promise<SocketClose & { frames: number; bytes: number }>;
	destroy: () => void;
}

/**
 * Open a browser socket over a raw TCP connection (hand-rolled handshake and
 * frame parser), for tests that need a peer which stops reading. Rejects when
 * the handshake does not answer 101.
 */
export async function openRawBrowserSocket(
	port: number,
	options: OpenBrowserSocketOptions = {},
): Promise<RawBrowserSocket> {
	const { connect } = await import("node:net");
	const url = new URL(socketUrlFor(`http://127.0.0.1:${port}`, options));
	const socket = connect({ host: "127.0.0.1", port });
	const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
	const head = Promise.withResolvers<void>();
	const closed = Promise.withResolvers<SocketClose & { frames: number; bytes: number }>();
	let chunks: Buffer[] = [];
	let buffered = 0;
	let handshaken = false;
	let frames = 0;
	let bytes = 0;
	const types = new Set<string>();

	/** Consume complete frames from the buffered chunks; resolves `closed` on a close frame. */
	const parseFrames = (): void => {
		for (;;) {
			if (buffered < 2) return;
			const first = Buffer.concat(chunks);
			chunks = [first];
			const opcode = first[0]! & 0x0f;
			const small = first[1]! & 0x7f;
			let headerBytes = 2;
			let length = small;
			if (small === 126) {
				if (first.length < 4) return;
				length = first.readUInt16BE(2);
				headerBytes = 4;
			} else if (small === 127) {
				if (first.length < 10) return;
				length = Number(first.readBigUInt64BE(2));
				headerBytes = 10;
			}
			if (first.length < headerBytes + length) return;
			const payload = first.subarray(headerBytes, headerBytes + length);
			const rest = first.subarray(headerBytes + length);
			chunks = rest.length > 0 ? [rest] : [];
			buffered = rest.length;
			if (opcode === 8) {
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
				const reason = payload.subarray(2).toString("utf8");
				closed.resolve({
					code,
					reason,
					kind: browserCloseFromCode(code, reason)?.kind ?? null,
					frames,
					bytes,
				});
				return;
			}
			if (opcode === 1) {
				frames++;
				bytes += payload.length;
				const type = /"frame":\{"type":"([a-z_]+)"/.exec(payload.subarray(0, 256).toString("utf8"));
				if (type !== null) types.add(type[1]!);
			}
		}
	};

	socket.on("data", (chunk: Buffer) => {
		if (!handshaken) {
			chunks.push(chunk);
			const text = Buffer.concat(chunks);
			const end = text.indexOf("\r\n\r\n");
			if (end < 0) {
				chunks = [text];
				return;
			}
			if (!text.subarray(0, end).toString("latin1").startsWith("HTTP/1.1 101")) {
				head.reject(new Error(`raw dial refused: ${text.subarray(0, end).toString("latin1")}`));
				return;
			}
			handshaken = true;
			const rest = text.subarray(end + 4);
			chunks = rest.length > 0 ? [rest] : [];
			buffered = rest.length;
			head.resolve();
			parseFrames();
			return;
		}
		chunks.push(chunk);
		buffered += chunk.length;
		parseFrames();
	});
	socket.on("error", (error) => head.reject(error));
	socket.on("close", () =>
		closed.resolve({
			code: 1006,
			reason: "tcp closed with no close frame",
			kind: null,
			frames,
			bytes,
		}),
	);
	socket.write(
		`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
			`Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
	);
	await head.promise;

	return {
		types,
		sendCommand: (command) => {
			const payload = Buffer.from(commandMessage(command as unknown as ClientCommand), "utf8");
			if (payload.length >= 65_536) throw new Error("raw client sends only short messages");
			const mask = Buffer.from(crypto.getRandomValues(new Uint8Array(4)));
			const frame = Buffer.alloc(payload.length < 126 ? 6 : 8);
			frame[0] = 0x81;
			let offset = 1;
			if (payload.length < 126) {
				frame[offset++] = 0x80 | payload.length;
			} else {
				frame[offset++] = 0x80 | 126;
				frame.writeUInt16BE(payload.length, offset);
				offset += 2;
			}
			mask.copy(frame, offset);
			const masked = Buffer.from(payload);
			for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
			socket.write(Buffer.concat([frame, masked]));
		},
		pause: () => {
			socket.pause();
		},
		drainToClose: () => {
			socket.resume();
			return closed.promise;
		},
		destroy: () => socket.destroy(),
	};
}
