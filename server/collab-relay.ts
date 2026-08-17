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
 *   connected, 4028 too many rooms, 4029 room full.
 *
 * The host creates the room. Guests join only while a host is live. Host
 * socket close starts an "orphan" grace period (TTL): a host reconnect within
 * the TTL re-adopts the room; TTL expiry destroys it (guests closed 4001).
 * `closeRoom()` destroys a room immediately, sending `{"t":"room-closed"}`
 * to every guest first.
 *
 * Host upgrades are privileged: they create rooms, so an optional
 * `authorizeHost` predicate gates them (the daemon wires the R14 bearer
 * gate — loopback exempt, off-loopback needs the token) and `maxRooms` caps
 * the number of rooms. Guests are never gated: they join by E2E room key.
 * New host rooms past the cap are refused with HTTP 503 before the upgrade
 * (re-adoption of an existing live/orphaned room is always allowed — the
 * host-resume path must not be cut); a `handleOpen` backstop closes 4028 for
 * the narrow race where concurrent new-room hosts all passed the upgrade
 * check.
 */

import {
	ENVELOPE_HEADER_LENGTH,
	rewriteEnvelopePeer,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type {
	RelayControlToGuest,
	RelayControlToHost,
} from "@oh-my-pi/pi-coding-agent/collab/protocol";
import type { BufferSource, Server, ServerWebSocket } from "bun";

/**
 * Per-socket data for every socket served by the omp-web daemon. Only
 * collab relay sockets exist (the agent-driving channel is SSE + POST, and
 * the removed WS transport's "web" variant was never constructed — audit
 * #18); the type is the relay socket data directly.
 */
export interface RelaySocketData {
	roomId: string;
	role: "host" | "guest";
	/** Assigned on registration; undefined until then (hosts never get one). */
	peerId?: number;
}

export interface RelayOptions {
	/** Maximum number of concurrent guests per room. Default 64. */
	maxGuests?: number;
	/**
	 * Maximum number of concurrent rooms (live + orphaned). Default 256. A
	 * host upgrade for a NEW room past the cap is refused with HTTP 503
	 * before the upgrade; re-adoption of an existing room is always allowed.
	 */
	maxRooms?: number;
	/** How long a room stays alive after its host disconnects. Default 60_000 ms. */
	orphanTtlMs?: number;
	/**
	 * Authorization gate for host-role upgrades. Called before the upgrade;
	 * when it returns false the upgrade is refused with HTTP 401 (the caller
	 * responds). Guests are never gated — they join by E2E room key. Absent
	 * = hosts always allowed.
	 */
	authorizeHost?: (req: Request, srv: Server<RelaySocketData>) => boolean;
}

/**
 * The bun server-side websocket (as handed to Bun.serve's handlers). Note:
 * this is `ServerWebSocket<T>`, NOT the client-side global `WebSocket` — the
 * server socket carries the generic `.data` payload and is what index.ts's
 * `ServerWebSocket<RelaySocketData>` values are assignable to.
 */
type RelayWs = ServerWebSocket<RelaySocketData>;

/**
 * Outcome of a relay room-path upgrade attempt.
 * - `{ handled: true }` — the pathname matched a room and the upgrade
 *   succeeded; the request is fully consumed.
 * - `{ handled: false, status, reason }` — the pathname matched a room but
 *   the upgrade was refused BEFORE the handshake (unauthorized host 401,
 *   room cap 503, or a failed upgrade 400); the caller should respond with
 *   `status`.
 * - `null` — the pathname is not a room path; web handling should continue.
 */
export type RelayUpgradeResult =
	| { handled: true }
	| { handled: false; status: number; reason: string }
	| null;

export interface RelayHandle {
	/**
	 * Handle a candidate relay room path (/r/<roomId>?role=host|guest). See
	 * {@link RelayUpgradeResult}. Call before /download & static.
	 */
	handleUpgrade(url: URL, srv: Server<RelaySocketData>, req: Request): RelayUpgradeResult;
	handleOpen(ws: RelayWs): void;
	handleMessage(ws: RelayWs, raw: string | Buffer): void;
	handleClose(ws: RelayWs): void;
	/** Immediate teardown: guests get TEXT control {"t":"room-closed"} then close(4001,"room closed"); room removed. */
	closeRoom(roomId: string): void;
	roomCount(): number;
}

const DEFAULT_MAX_GUESTS = 64;
const DEFAULT_MAX_ROOMS = 256;
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
	readonly #maxRooms: number;
	readonly #orphanTtlMs: number;
	readonly #authorizeHost: ((req: Request, srv: Server<RelaySocketData>) => boolean) | undefined;

	constructor(opts?: RelayOptions) {
		this.#maxGuests = opts?.maxGuests ?? DEFAULT_MAX_GUESTS;
		this.#maxRooms = opts?.maxRooms ?? DEFAULT_MAX_ROOMS;
		this.#orphanTtlMs = opts?.orphanTtlMs ?? DEFAULT_ORPHAN_TTL_MS;
		this.#authorizeHost = opts?.authorizeHost;
	}

	handleUpgrade(url: URL, srv: Server<RelaySocketData>, req: Request): RelayUpgradeResult {
		const match = ROOM_PATH_RE.exec(url.pathname);
		if (!match) return null;
		const role = url.searchParams.get("role");
		if (role !== "host" && role !== "guest") return null;
		const roomId = match[1];

		if (role === "host") {
			// Hosts create rooms, so they are gated like the agent-driving
			// endpoints (R14): loopback exempt, off-loopback peers need the
			// bearer token. Guests join by E2E room key — never gated here.
			if (this.#authorizeHost !== undefined && !this.#authorizeHost(req, srv)) {
				return { handled: false, status: 401, reason: "Unauthorized" };
			}
			// New host rooms are capped. Re-adoption of an existing room
			// (live or orphaned) is always allowed — the host-resume path
			// must not be cut off by the cap.
			if (!this.#rooms.has(roomId) && this.#rooms.size >= this.#maxRooms) {
				return { handled: false, status: 503, reason: "too many rooms" };
			}
		}

		const ok = srv.upgrade(req, {
			data: { roomId, role },
		});
		if (!ok) return { handled: false, status: 400, reason: "WebSocket upgrade failed" };
		return { handled: true };
	}

	handleOpen(ws: RelayWs): void {
		const data = ws.data;
		const roomId = data.roomId;

		if (data.role === "host") {
			const room = this.#rooms.get(roomId);
			if (!room) {
				// Host creates the room. The upgrade-time cap check can be
				// raced by concurrent new-room hosts, so enforce the cap here
				// too (4028, matching the other handleOpen policy closes).
				if (this.#rooms.size >= this.#maxRooms) {
					closeSafe(ws, 4028, "too many rooms");
					return;
				}
				this.#rooms.set(roomId, {
					host: ws,
					hostOrphanSince: null,
					guests: new Map(),
					nextPeerId: 1,
					ttlTimer: null,
				});
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
		sendSafe(
			room.host,
			JSON.stringify({ t: "peer-joined", peer: peerId } satisfies RelayControlToHost),
		);
	}

	handleMessage(ws: RelayWs, raw: string | Buffer): void {
		const data = ws.data;
		// TEXT frames from clients are ignored (controls only ever flow relay→client).
		if (typeof raw === "string") return;
		if (raw.byteLength < ENVELOPE_HEADER_LENGTH) return;
		const room = this.#rooms.get(data.roomId);
		if (!room) return;

		if (data.role === "host") {
			// Only the registered host socket may broadcast.
			if (room.host !== ws) return;
			const target = new DataView(raw.buffer, raw.byteOffset, ENVELOPE_HEADER_LENGTH).getUint32(
				0,
				false,
			);
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
			sendSafe(
				room.host,
				JSON.stringify({ t: "peer-left", peer: peerId } satisfies RelayControlToHost),
			);
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
