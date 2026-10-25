/**
 * A browser socket (`/ws`, OMP_PROTO 6) on a raw TCP connection, for tests
 * that must control when the client reads. `pause()` stops reading the kernel
 * socket (a tab that stopped draining: its receive window fills, then the
 * edge's send queue), `resume()` reads again. The HTTP upgrade is written by
 * hand and the server's frames (unmasked, 7/16/64-bit lengths, never
 * fragmented by the edge) are parsed here into the message shapes
 * `BrowserSocket` keeps. Commands go out as client text frames with an
 * all-zero mask key (a valid key that leaves the payload as is). Named
 * *.testkit.ts so bun test discovery never picks it up as a suite.
 */
import { randomBytes } from "node:crypto";
import { BROWSER_SOCKET_PATH, parseServerMessage } from "#lib/wire/browser-socket";
import { OMP_PROTO, type ServerFrame } from "#lib/wire/protocol";
import { type SocketClose, waitForEvent } from "./edge.testkit";

export class RawBrowserSocket {
	readonly clientId: string;
	readonly port: number;
	/** Every TCP byte received, handshake included. */
	bytes = 0;
	readonly frames: ServerFrame[] = [];
	readonly events: Array<{ id: number; frame: ServerFrame }> = [];
	/** Every text message received, in order (raw JSON text). */
	readonly messages: string[] = [];
	readonly pings: number[] = [];
	readonly acks: string[] = [];
	readonly nacks: Array<{ id: string; status: number; error: string }> = [];
	/** Set once a close frame was parsed. */
	closeInfo: SocketClose | null = null;
	/** True once the TCP connection is gone (or this side destroyed it). */
	isClosed = false;
	readonly #after: number | null;
	readonly #closed = Promise.withResolvers<void>();
	readonly #upgraded = Promise.withResolvers<void>();
	#socket: Bun.Socket | null = null;
	#buf: Buffer = Buffer.alloc(0);
	#handshaken = false;
	#unsent: Buffer | null = null;

	constructor(port: number, clientId: string = crypto.randomUUID(), after: number | null = null) {
		this.port = port;
		this.clientId = clientId;
		this.#after = after;
	}

	/** Dial and resolve once the 101 upgrade response arrived. */
	async open(): Promise<void> {
		const afterParam = this.#after === null ? "" : `&after=${this.#after}`;
		const request = Buffer.from(
			`GET ${BROWSER_SOCKET_PATH}?client=${this.clientId}&proto=${OMP_PROTO}${afterParam} HTTP/1.1\r\n` +
				`Host: 127.0.0.1:${this.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
				`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
		);
		this.#socket = await Bun.connect({
			hostname: "127.0.0.1",
			port: this.port,
			socket: {
				open: (socket) => this.#writeBytes(socket, request),
				data: (_socket, chunk) => this.#onData(chunk),
				drain: (socket) => {
					const rest = this.#unsent;
					this.#unsent = null;
					if (rest !== null) this.#writeBytes(socket, rest);
				},
				close: () => this.#onTcpClose(),
				error: () => this.#onTcpClose(),
			},
		});
		await this.#upgraded.promise;
	}

	#writeBytes(socket: Bun.Socket, bytes: Buffer): void {
		const written = socket.write(bytes);
		if (written < bytes.length) this.#unsent = bytes.subarray(written);
	}

	#onTcpClose(): void {
		this.isClosed = true;
		this.#closed.resolve();
		// A dial that never got its 101 (refused, closed early) must not hang open().
		this.#upgraded.reject(new Error("raw browser socket closed before the upgrade"));
	}

	#onData(chunk: Uint8Array): void {
		this.bytes += chunk.byteLength;
		this.#buf = this.#buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buf, chunk]);
		if (!this.#handshaken) {
			const end = this.#buf.indexOf("\r\n\r\n");
			if (end < 0) return;
			const head = this.#buf.subarray(0, end).toString("latin1");
			this.#buf = this.#buf.subarray(end + 4);
			if (!head.startsWith("HTTP/1.1 101")) {
				this.#upgraded.reject(new Error(`upgrade refused: ${head.split("\r\n")[0]}`));
				return;
			}
			this.#handshaken = true;
			this.#upgraded.resolve();
		}
		for (;;) {
			const buf = this.#buf;
			if (buf.length < 2) return;
			const opcode = buf[0]! & 0x0f;
			if ((buf[0]! & 0x80) === 0 || opcode === 0) throw new Error("fragmented server frame");
			if ((buf[1]! & 0x80) !== 0) throw new Error("masked server frame");
			let length = buf[1]! & 0x7f;
			let header = 2;
			if (length === 126) {
				if (buf.length < 4) return;
				length = buf.readUInt16BE(2);
				header = 4;
			} else if (length === 127) {
				if (buf.length < 10) return;
				length = Number(buf.readBigUInt64BE(2));
				header = 10;
			}
			if (buf.length < header + length) return;
			const payload = buf.subarray(header, header + length);
			this.#buf = buf.subarray(header + length);
			if (opcode === 1) {
				this.#onText(payload.toString("utf8"));
			} else if (opcode === 8) {
				this.#onCloseFrame(payload);
				return;
			} else if (opcode === 9) {
				this.#writeFrame(0x8a, payload);
			} else if (opcode !== 10) {
				throw new Error(`unexpected server frame opcode ${opcode}`);
			}
		}
	}

	#onText(text: string): void {
		this.messages.push(text);
		const message = parseServerMessage(text);
		if (message === null) throw new Error(`unparseable server message: ${text.slice(0, 200)}`);
		switch (message.kind) {
			case "frame":
				this.frames.push(message.frame);
				this.events.push({ id: message.seq ?? -1, frame: message.frame });
				return;
			case "ping":
				this.pings.push(message.at);
				return;
			case "ack":
				this.acks.push(message.id);
				return;
			case "nack":
				this.nacks.push({ id: message.id, status: message.status, error: message.error });
				return;
		}
	}

	#onCloseFrame(payload: Buffer): void {
		this.closeInfo = {
			code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005,
			reason: payload.length > 2 ? payload.subarray(2).toString("utf8") : "",
		};
		// Answer the close handshake, then end our side.
		this.#writeFrame(0x88, payload.subarray(0, 2));
		this.#socket?.end();
		this.#closed.resolve();
	}

	/** One client frame, masked with the all-zero key (payload bytes unchanged). */
	#writeFrame(firstByte: number, payload: Uint8Array): void {
		const socket = this.#socket;
		if (socket === null || this.isClosed) return;
		const length = payload.byteLength;
		let header: Buffer;
		if (length < 126) {
			header = Buffer.from([firstByte, 0x80 | length]);
		} else if (length < 65536) {
			header = Buffer.from([firstByte, 0x80 | 126, length >> 8, length & 0xff]);
		} else {
			header = Buffer.alloc(10);
			header[0] = firstByte;
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(length), 2);
		}
		this.#writeBytes(socket, Buffer.concat([header, Buffer.alloc(4), payload]));
	}

	/**
	 * Send one command as a text frame (an id is minted when the test gives
	 * none) and return its id. It does not wait for the ack: a paused socket
	 * cannot read it; observe the effect, or `acks` once reading.
	 */
	send(cmd: Record<string, unknown>): string {
		const id = typeof cmd.id === "string" && cmd.id !== "" ? cmd.id : crypto.randomUUID();
		this.#writeFrame(0x81, Buffer.from(JSON.stringify({ cmd: { ...cmd, id } })));
		return id;
	}

	/** Stop reading: the kernel buffers fill, then the edge's send queue does. */
	pause(): void {
		this.#socket?.pause();
	}

	resume(): void {
		this.#socket?.resume();
	}

	/** Hard-close the TCP connection (a tab vanishing). */
	destroy(): void {
		this.#socket?.terminate();
		this.isClosed = true;
		this.#closed.resolve();
	}

	/**
	 * Resolves once a close frame was parsed (its code and reason) or the TCP
	 * connection ended (null: closed without one); rejects on timeout. The
	 * socket must be reading.
	 */
	async end(timeoutMs = 5000): Promise<SocketClose | null> {
		const timeout = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => timeout.reject(new Error("raw browser socket did not close")),
			timeoutMs,
		);
		try {
			await Promise.race([this.#closed.promise, timeout.promise]);
			return this.closeInfo;
		} finally {
			clearTimeout(timer);
		}
	}

	waitForFrame(
		pred: (f: ServerFrame) => boolean,
		what = "frame",
		timeoutMs = 5000,
	): Promise<ServerFrame> {
		return waitForEvent(this.events, (ev) => pred(ev.frame), what, timeoutMs).then(
			(ev) => ev.frame,
		);
	}

	waitForEvent(
		pred: (ev: { id: number; frame: ServerFrame }) => boolean,
		what = "event",
		timeoutMs = 5000,
	): Promise<{ id: number; frame: ServerFrame }> {
		return waitForEvent(this.events, pred, what, timeoutMs);
	}
}
