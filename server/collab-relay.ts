/**
 * Collab relay: WebSocket rooms that forward opaque AES-GCM envelopes between
 * one host and up to `maxGuests` guests, plus TEXT control messages.
 *
 * Wire contract (matches omp's collab protocol, see
 * @oh-my-pi/pi-coding-agent/src/collab/relay-client.ts):
 * - Clients connect to `/r/<roomId>?role=host|guest`.
 * - Binary frames are `[4B uint32 BE peerId][sealed payload]` envelopes.
 * - Host→relay peerId 0 broadcasts to all guests; peerId N targets guest N.
 * - Guest→relay is always 0; the relay rewrites it to the sender's id.
 * - TEXT control: to host `{"t":"peer-joined"|"peer-left","peer":N}`,
 *   to guest `{"t":"room-closed"}`.
 * - Fatal codes: 4001 room closed, 4004 no such room, 4009 host already
 *   connected, 4029 room full.
 *
 * The host creates the room. Guests join only while a host is live. Host
 * socket close starts an "orphan" grace period (TTL): a host reconnect within
 * the TTL re-adopts the room; TTL expiry destroys it (guests closed 4001).
 * `closeRoom()` destroys a room immediately, sending `{"t":"room-closed"}`
 * to every guest first.
 */

import { ENVELOPE_HEADER_LENGTH, rewriteEnvelopePeer } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { RelayControlToGuest, RelayControlToHost } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { BufferSource, Server, ServerWebSocket } from "bun";

/** Per-socket data for every socket served by the omp-web daemon (web + relay). */
export type SocketData = { kind: "web"; attached: string | null } | RelaySocketData;

export interface RelaySocketData {
	kind: "relay";
	roomId: string;
	role: "host" | "guest";
	/** Assigned on registration; undefined until then (hosts never get one). */
	peerId?: number;
}

export interface RelayOptions {
	/** Maximum number of concurrent guests per room. Default 64. */
	maxGuests?: number;
	/** How long a room stays alive after its host disconnects. Default 60_000 ms. */
	orphanTtlMs?: number;
}

/**
 * The bun server-side websocket (as handed to Bun.serve's handlers). Note:
 * this is `ServerWebSocket<T>`, NOT the client-side global `WebSocket` — the
 * server socket carries the generic `.data` payload and is what index.ts's
 * `ServerWebSocket<SocketData>` values are assignable to.
 */
type RelayWs = ServerWebSocket<SocketData>;

export interface RelayHandle {
	/**
	 * Returns true when pathname matches ^/r/<roomId> AND the upgrade
	 * succeeded. Call before /download & static.
	 */
	handleUpgrade(url: URL, srv: Server<SocketData>, req: Request): boolean;
	handleOpen(ws: RelayWs): void;
	handleMessage(ws: RelayWs, raw: string | Buffer): void;
	handleClose(ws: RelayWs): void;
	/** Immediate teardown: guests get TEXT control {"t":"room-closed"} then close(4001,"room closed"); room removed. */
	closeRoom(roomId: string): void;
	roomCount(): number;
}

const DEFAULT_MAX_GUESTS = 64;
const DEFAULT_ORPHAN_TTL_MS = 60_000;

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;

interface Room {
	host: RelayWs | null;
	hostOrphanSince: number | null;
	guests: Map<number, RelayWs>;
	nextPeerId: number;
	ttlTimer: Timer | null;
}

/** The relay never throws on a dead socket: a send on a closed socket must be a no-op. */
function sendSafe(ws: RelayWs, data: string | BufferSource): void {
	try {
		ws.send(data);
	} catch {
		// Socket already closed — ignore.
	}
}

function closeSafe(ws: RelayWs, code: number, reason: string): void {
	try {
		ws.close(code, reason);
	} catch {
		// Socket already closed — ignore.
	}
}

class CollabRelay implements RelayHandle {
	readonly #rooms = new Map<string, Room>();
	readonly #maxGuests: number;
	readonly #orphanTtlMs: number;

	constructor(opts?: RelayOptions) {
		this.#maxGuests = opts?.maxGuests ?? DEFAULT_MAX_GUESTS;
		this.#orphanTtlMs = opts?.orphanTtlMs ?? DEFAULT_ORPHAN_TTL_MS;
	}

	handleUpgrade(url: URL, srv: Server<SocketData>, req: Request): boolean {
		const match = ROOM_PATH_RE.exec(url.pathname);
		if (!match) return false;
		const role = url.searchParams.get("role");
		if (role !== "host" && role !== "guest") return false;
		return srv.upgrade(req, {
			data: { kind: "relay", roomId: match[1], role },
		});
	}

	handleOpen(ws: RelayWs): void {
		const data = ws.data;
		// Only relay sockets reach these handlers, but stay defensive.
		if (data.kind !== "relay") return;
		const roomId = data.roomId;

		if (data.role === "host") {
			const room = this.#rooms.get(roomId);
			if (!room) {
				// Host creates the room.
				this.#rooms.set(roomId, { host: ws, hostOrphanSince: null, guests: new Map(), nextPeerId: 1, ttlTimer: null });
				return;
			}
			if (room.host !== null) {
				// A host is already connected for this room.
				closeSafe(ws, 4009, "a host is already connected for this room");
				return;
			}
			// Room is orphaned: re-adopt and cancel the orphan TTL.
			if (room.ttlTimer !== null) {
				clearTimeout(room.ttlTimer);
				room.ttlTimer = null;
			}
			room.host = ws;
			room.hostOrphanSince = null;
			return;
		}

		// Guest: room must exist with a live host.
		const room = this.#rooms.get(roomId);
		if (!room || room.host === null) {
			closeSafe(ws, 4004, "no such room");
			return;
		}
		if (room.guests.size >= this.#maxGuests) {
			closeSafe(ws, 4029, "room is full");
			return;
		}
		const peerId = room.nextPeerId++;
		data.peerId = peerId;
		room.guests.set(peerId, ws);
		sendSafe(room.host, JSON.stringify({ t: "peer-joined", peer: peerId } satisfies RelayControlToHost));
	}

	handleMessage(ws: RelayWs, raw: string | Buffer): void {
		const data = ws.data;
		if (data.kind !== "relay") return;
		// TEXT frames from clients are ignored (controls only ever flow relay→client).
		if (typeof raw === "string") return;
		if (raw.byteLength < ENVELOPE_HEADER_LENGTH) return;
		const room = this.#rooms.get(data.roomId);
		if (!room) return;

		if (data.role === "host") {
			// Only the registered host socket may broadcast.
			if (room.host !== ws) return;
			const target = new DataView(raw.buffer, raw.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(0, false);
			if (target === 0) {
				for (const guest of room.guests.values()) sendSafe(guest, raw);
			} else {
				const guest = room.guests.get(target);
				if (guest) sendSafe(guest, raw);
			}
			return;
		}

		// Guest: must be registered, rewrite the sender id in place, forward to host.
		const peerId = data.peerId;
		if (peerId === undefined) return;
		if (room.guests.get(peerId) !== ws) return;
		rewriteEnvelopePeer(raw, peerId);
		if (room.host !== null) sendSafe(room.host, raw);
	}

	handleClose(ws: RelayWs): void {
		const data = ws.data;
		if (data.kind !== "relay") return;
		const room = this.#rooms.get(data.roomId);
		if (!room) return;

		if (data.role === "host") {
			// Already orphaned/closed host socket closing again: no-op.
			if (room.host !== ws) return;
			room.host = null;
			room.hostOrphanSince = Date.now();
			room.ttlTimer = setTimeout(() => this.#expireOrphan(room, data.roomId), this.#orphanTtlMs);
			return;
		}

		const peerId = data.peerId;
		if (peerId === undefined) return;
		if (room.guests.get(peerId) !== ws) return;
		room.guests.delete(peerId);
		data.peerId = undefined;
		if (room.host !== null) {
			sendSafe(room.host, JSON.stringify({ t: "peer-left", peer: peerId } satisfies RelayControlToHost));
		}
	}

	closeRoom(roomId: string): void {
		const room = this.#rooms.get(roomId);
		if (!room) return;
		if (room.ttlTimer !== null) {
			clearTimeout(room.ttlTimer);
			room.ttlTimer = null;
		}
		this.#rooms.delete(roomId);
		for (const guest of room.guests.values()) {
			sendSafe(guest, JSON.stringify({ t: "room-closed" } satisfies RelayControlToGuest));
			closeSafe(guest, 4001, "room closed");
		}
		room.guests.clear();
		// The host socket is intentionally NOT closed here; the collab host
		// adapter closes its own socket via stop().
		room.host = null;
	}

	roomCount(): number {
		return this.#rooms.size;
	}

	/** Orphan TTL expiry: destroy the room, closing remaining guests with 4001. */
	#expireOrphan(room: Room, roomId: string): void {
		if (this.#rooms.get(roomId) !== room) return;
		room.ttlTimer = null;
		this.#rooms.delete(roomId);
		for (const guest of room.guests.values()) closeSafe(guest, 4001, "room closed");
		room.guests.clear();
	}
}

export function createRelay(opts?: RelayOptions): RelayHandle {
	return new CollabRelay(opts);
}
