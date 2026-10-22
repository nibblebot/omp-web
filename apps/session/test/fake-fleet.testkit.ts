/**
 * Fake fleet for the session's callback tests: a small Bun.serve that speaks
 * the OMP_CALLBACK_PROTO 2 contract (GET /callback/ws upgrade, one text
 * message per envelope, pair_ready first, typed refusal closes) without any of
 * the real fleet's registry. Tests drive it through the FakeFleet handle and
 * read what the session sent from `received` / `raw`.
 */
import {
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_PROTO_HEADER,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_WS_MAX_PAYLOAD_BYTES,
	CALLBACK_WS_PATH,
	CallbackError,
	OMP_CALLBACK_PROTO,
	PAIR_CREDIT_STEP_BYTES,
	callbackCloseFor,
	decodeEnvelope,
	type CallbackEnvelope,
	type CallbackErrorCode,
	type CallbackKind,
} from "#lib/wire/callback-protocol";

export interface FakeFleetOptions {
	workspaceId: string;
	generation: number;
	/** Credential the fleet accepts; anything else is refused `unauthorized`. */
	token: string;
	/**
	 * Refuse every upgrade (the fleet upgrades, then closes): with a typed ledger code, or with
	 * a raw close frame such as one whose reason names no code.
	 */
	refuse?: { code: CallbackErrorCode; message?: string } | { close: FakeFleetClose };
	/** Answer the pair route with a plain 404 and no upgrade (an old fleet without the route). */
	noRoute?: boolean;
	/** Withhold pair_ready on every accepted socket until releaseReady(). */
	holdReady?: boolean;
	/** Envelopes written in the same tick right behind pair_ready, so they share its socket read. */
	afterReady?: Array<{ streamId: string; kind: CallbackKind; payload: unknown }>;
	/** Cadence of `heartbeat` envelopes (streamId "transport") on every live socket; absent = none. */
	heartbeatMs?: number;
	/** Handler for POST /callback/bulk/*; default 404. */
	bulk?: (req: Request) => Response | Promise<Response>;
	/**
	 * Never grant pair credit by itself (a fleet that stopped consuming); grant()
	 * hands it out. By default the fake fleet grants like the real one: the
	 * cumulative consumed bytes, once PAIR_CREDIT_STEP_BYTES more were consumed.
	 */
	withholdCredit?: boolean;
}

export interface FakeFleetUpgrade {
	url: string;
	headers: Headers;
}

export interface FakeFleetClose {
	code: number;
	reason: string;
}

export interface FakeFleet {
	/** http base URL (loopback). */
	url: string;
	/** Every upgrade request, in dial order. */
	readonly upgrades: FakeFleetUpgrade[];
	/** Non-heartbeat envelopes the session sent, in arrival order. */
	readonly received: CallbackEnvelope[];
	/** Every text message the session sent, heartbeats included, in arrival order. */
	readonly raw: string[];
	/** How the session closed sockets, in close order. */
	readonly closes: FakeFleetClose[];
	/** Resolves once `count` received envelopes satisfy `match` (default: all). */
	whenReceived(count: number, match?: (envelope: CallbackEnvelope) => boolean): Promise<void>;
	/** Resolves once `count` upgrades have arrived. */
	whenUpgrades(count: number): Promise<void>;
	/** Resolves once `count` sockets have closed. */
	whenClosed(count: number): Promise<void>;
	/** Resolves once the newest socket has received `bytes` UTF-8 bytes of text messages. */
	whenConsumed(bytes: number): Promise<void>;
	/** Resolves once the first socket received pair_ready. */
	paired: Promise<void>;
	/** connectionId of the newest accepted socket, or null before the first. */
	connectionId(): string | null;
	/** UTF-8 bytes of every text message the newest socket received (the credit unit). */
	consumedBytes(): number;
	/** The most bytes any socket ever had received beyond the credit the fake fleet had granted it when each message arrived. */
	maxOutstandingBytes(): number;
	/** Sends a pair_credit grant on the newest live socket: `consumed` (cumulative), default everything consumed so far. */
	grant(consumed?: number): void;
	/** Sends one envelope on the newest live socket under the next fleet-side seq. */
	send(streamId: string, kind: CallbackKind, payload: unknown): void;
	/** Sends one raw text or binary message on the newest live socket. */
	sendRaw(data: string | Uint8Array): void;
	/** Sends pair_ready on every socket whose ready was withheld. */
	releaseReady(): void;
	/** Closes the newest live socket from the fleet side. */
	close(code?: number, reason?: string): void;
	stop(): void;
}

interface SocketData {
	connectionId: string;
	seq: number;
	refusal: FakeFleetClose | null;
	heartbeat: ReturnType<typeof setInterval> | undefined;
	readySent: boolean;
	/** Bytes received on this socket, and the cumulative value of the last grant. */
	consumed: number;
	granted: number;
}

type FleetSocket = Bun.ServerWebSocket<SocketData>;

export function startFakeFleet(options: FakeFleetOptions): FakeFleet {
	const upgrades: FakeFleetUpgrade[] = [];
	const received: CallbackEnvelope[] = [];
	const raw: string[] = [];
	const closes: FakeFleetClose[] = [];
	const sockets: FleetSocket[] = [];
	const waiters = new Set<() => void>();
	let resolvePaired: () => void = () => {};
	let maxOutstanding = 0;
	const paired = new Promise<void>((resolve) => {
		resolvePaired = resolve;
	});
	const notify = (): void => {
		for (const waiter of waiters) waiter();
	};
	const until = (ready: () => boolean): Promise<void> =>
		new Promise<void>((resolve) => {
			const check = (): void => {
				if (!ready()) return;
				waiters.delete(check);
				resolve();
			};
			waiters.add(check);
			check();
		});

	const envelopeFor = (
		ws: FleetSocket,
		streamId: string,
		kind: CallbackKind,
		payload: unknown,
	): string =>
		JSON.stringify({
			version: OMP_CALLBACK_PROTO,
			workspaceId: options.workspaceId,
			generation: options.generation,
			connectionId: ws.data.connectionId,
			streamId,
			seq: ++ws.data.seq,
			kind,
			payload,
			at: Date.now(),
		} satisfies CallbackEnvelope);

	const sendReady = (ws: FleetSocket): void => {
		if (ws.data.readySent) return;
		ws.data.readySent = true;
		ws.send(
			envelopeFor(ws, CALLBACK_TRANSPORT_STREAM_ID, "control", {
				type: CALLBACK_PAIR_READY_TYPE,
				connectionId: ws.data.connectionId,
				generation: options.generation,
			}),
		);
		for (const message of options.afterReady ?? []) {
			ws.send(envelopeFor(ws, message.streamId, message.kind, message.payload));
		}
		resolvePaired();
	};

	const refusalFor = (req: Request): FakeFleetClose | null => {
		const refuse = (code: CallbackErrorCode, message: string): FakeFleetClose =>
			callbackCloseFor(new CallbackError(code, message));
		if (options.refuse !== undefined) {
			if ("close" in options.refuse) return options.refuse.close;
			return refuse(options.refuse.code, options.refuse.message ?? "refused by the fake fleet");
		}
		if (req.headers.get("authorization") !== `Bearer ${options.token}`) {
			return refuse("unauthorized", "unknown credential");
		}
		if (req.headers.get(CALLBACK_PROTO_HEADER) !== String(OMP_CALLBACK_PROTO)) {
			return refuse("proto_unsupported", "callback protocol mismatch");
		}
		return null;
	};

	const server = Bun.serve<SocketData>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req, srv) {
			const path = new URL(req.url).pathname;
			if (path === CALLBACK_WS_PATH) {
				upgrades.push({ url: req.url, headers: req.headers });
				notify();
				if (options.noRoute === true) return new Response("not found", { status: 404 });
				const data: SocketData = {
					connectionId: req.headers.get("x-omp-connection-id") ?? "",
					seq: 0,
					refusal: refusalFor(req),
					heartbeat: undefined,
					readySent: false,
					consumed: 0,
					granted: 0,
				};
				if (srv.upgrade(req, { data })) return undefined;
				return new Response("upgrade failed", { status: 400 });
			}
			if (path.startsWith("/callback/bulk/") && options.bulk !== undefined) {
				return options.bulk(req);
			}
			return new Response("not found", { status: 404 });
		},
		websocket: {
			perMessageDeflate: false,
			maxPayloadLength: CALLBACK_WS_MAX_PAYLOAD_BYTES,
			open(ws) {
				if (ws.data.refusal !== null) {
					ws.close(ws.data.refusal.code, ws.data.refusal.reason);
					return;
				}
				sockets.push(ws);
				if (options.holdReady !== true) sendReady(ws);
				if (options.heartbeatMs !== undefined) {
					ws.data.heartbeat = setInterval(() => {
						ws.send(envelopeFor(ws, CALLBACK_TRANSPORT_STREAM_ID, "heartbeat", {}));
					}, options.heartbeatMs);
				}
				notify();
			},
			message(ws, message) {
				if (typeof message !== "string") return;
				raw.push(message);
				const envelope = decodeEnvelope(message);
				if (envelope.kind !== "heartbeat") received.push(envelope);
				ws.data.consumed += Buffer.byteLength(message, "utf8");
				maxOutstanding = Math.max(maxOutstanding, ws.data.consumed - ws.data.granted);
				if (
					options.withholdCredit !== true &&
					ws.data.consumed - ws.data.granted >= PAIR_CREDIT_STEP_BYTES
				) {
					ws.send(
						envelopeFor(ws, CALLBACK_TRANSPORT_STREAM_ID, "control", {
							type: "pair_credit",
							consumed: ws.data.consumed,
						}),
					);
					ws.data.granted = ws.data.consumed;
				}
				notify();
			},
			close(ws, code, reason) {
				clearInterval(ws.data.heartbeat);
				const at = sockets.indexOf(ws);
				if (at !== -1) sockets.splice(at, 1);
				closes.push({ code, reason });
				notify();
			},
		},
	});

	const live = (): FleetSocket => {
		const ws = sockets[sockets.length - 1];
		if (ws === undefined) throw new Error("fake fleet has no live socket");
		return ws;
	};

	return {
		url: `http://127.0.0.1:${server.port}`,
		upgrades,
		received,
		raw,
		closes,
		whenReceived: (count, match) =>
			until(() => (match ? received.filter(match).length : received.length) >= count),
		whenUpgrades: (count) => until(() => upgrades.length >= count),
		whenClosed: (count) => until(() => closes.length >= count),
		whenConsumed: (bytes) =>
			until(() => (sockets[sockets.length - 1]?.data.consumed ?? 0) >= bytes),
		paired,
		connectionId: () => sockets[sockets.length - 1]?.data.connectionId ?? null,
		consumedBytes: () => sockets[sockets.length - 1]?.data.consumed ?? 0,
		maxOutstandingBytes: () => maxOutstanding,
		grant(consumed) {
			const ws = live();
			const value = consumed ?? ws.data.consumed;
			ws.send(
				envelopeFor(ws, CALLBACK_TRANSPORT_STREAM_ID, "control", {
					type: "pair_credit",
					consumed: value,
				}),
			);
			ws.data.granted = Math.max(ws.data.granted, value);
		},
		send(streamId, kind, payload) {
			const ws = live();
			ws.send(envelopeFor(ws, streamId, kind, payload));
		},
		sendRaw(data) {
			live().send(data);
		},
		releaseReady() {
			for (const ws of sockets) sendReady(ws);
		},
		close(code, reason) {
			live().close(code, reason);
		},
		stop() {
			for (const ws of sockets) clearInterval(ws.data.heartbeat);
			server.stop(true);
		},
	};
}
