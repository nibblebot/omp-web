/**
 * A fleet whose socket accepts the pair, confirms it (pair_ready) and keeps
 * writing heartbeats, but never reads what the session sends: the shape of a
 * wedged peer. Bun.serve cannot pause a server socket, so this speaks just
 * enough RFC 6455 over node:net to handshake and write unmasked text frames.
 */
import { createHash } from "node:crypto";
import net from "node:net";
import {
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_TRANSPORT_STREAM_ID,
	OMP_CALLBACK_PROTO,
} from "#lib/wire/callback-protocol";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface StalledFleet {
	/** http base URL (loopback). */
	url: string;
	/** Number of upgrade requests accepted. */
	readonly upgrades: number;
	stop(): void;
}

/** One unmasked server text frame carrying `text` (payloads here stay under 64 KiB). */
function textFrame(text: string): Buffer {
	const body = Buffer.from(text, "utf8");
	const header =
		body.length < 126
			? Buffer.from([0x81, body.length])
			: Buffer.from([0x81, 126, body.length >> 8, body.length & 0xff]);
	return Buffer.concat([header, body]);
}

export async function startStalledFleet(options: {
	workspaceId: string;
	generation: number;
	heartbeatMs: number;
}): Promise<StalledFleet> {
	const sockets = new Set<net.Socket>();
	const timers = new Set<ReturnType<typeof setInterval>>();
	let upgrades = 0;
	const server = net.createServer((socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
		socket.on("error", () => {});
		socket.once("data", (request) => {
			const text = request.toString("latin1");
			const key = /^sec-websocket-key: (.+)\r$/im.exec(text)?.[1];
			const connectionId = /^x-omp-connection-id: (.+)\r$/im.exec(text)?.[1];
			if (key === undefined || connectionId === undefined) {
				socket.destroy();
				return;
			}
			upgrades++;
			const accept = createHash("sha1")
				.update(key + WEBSOCKET_GUID)
				.digest("base64");
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
			);
			let seq = 0;
			const frame = (kind: "control" | "heartbeat", payload: unknown): Buffer =>
				textFrame(
					JSON.stringify({
						version: OMP_CALLBACK_PROTO,
						workspaceId: options.workspaceId,
						generation: options.generation,
						connectionId,
						streamId: CALLBACK_TRANSPORT_STREAM_ID,
						seq: ++seq,
						kind,
						payload,
						at: Date.now(),
					}),
				);
			socket.write(
				frame("control", {
					type: CALLBACK_PAIR_READY_TYPE,
					connectionId,
					generation: options.generation,
				}),
			);
			// From here the socket is never read again: the session's bytes pile up in the kernel.
			socket.pause();
			const heartbeat = setInterval(
				() => socket.write(frame("heartbeat", {})),
				options.heartbeatMs,
			);
			timers.add(heartbeat);
			socket.on("close", () => clearInterval(heartbeat));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no listen address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		get upgrades() {
			return upgrades;
		},
		stop() {
			for (const timer of timers) clearInterval(timer);
			for (const socket of sockets) socket.destroy();
			server.close();
		},
	};
}
