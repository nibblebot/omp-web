/**
 * Shared controlled daemon for the fleet suites: a session-side callback pair
 * (one WebSocket on /callback/ws, OMP_CALLBACK_PROTO 2) dialed OUT to a real
 * DaemonTransportRegistry over loopback HTTP, exactly as
 * apps/session/fleet-callback.ts dials it. The fleet never dials the daemon,
 * so this fake only ever dials.
 *
 * Behaviour mirrors the daemon half: the pair is live once pair_ready arrives
 * as the first message; a dropped socket (network loss) or a transport error
 * redials after a backoff on a fresh connectionId with a fresh seq space (the
 * fleet never resumes a socket; browser-stream replay is application level).
 * A close carrying a credential rejection (unauthorized, invalid_identity,
 * generation_obsolete) or proto_unsupported records the typed refusal and
 * stops redialing, the way a real session shuts down.
 */
import { randomUUID } from "node:crypto";
import {
	CALLBACK_ERROR_HTTP_STATUS,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_PROTO_HEADER,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_WS_PATH,
	callbackErrorFromClose,
	decodeEnvelope,
	envelopeFraming,
	type CallbackEnvelope,
	type CallbackErrorCode,
	OMP_CALLBACK_PROTO,
} from "#lib/wire/callback-protocol";

export interface CallbackDaemonOpts {
	/** Fleet callback base URL, no /callback suffix (the --fleet-stdin callback.url). */
	url: string;
	workspaceId: string;
	generation: number;
	/** 64-hex enrollment credential (the --fleet-stdin callback.token). */
	token: string;
	/** Initial redial backoff (doubles to redialMaxMs). Defaults 25ms / 250ms. */
	redialMinMs?: number;
	redialMaxMs?: number;
}

export interface CallbackRejection {
	/** HTTP status of the refusal's ledger code (the close code is 4000 + this). */
	status: number;
	/** Ledger error code the fleet closed the socket with. */
	error: string;
}

export interface CallbackDaemon {
	/** connectionId of the current (or last) socket; each dial mints a fresh one. */
	readonly connectionId: string;
	/** pair_ready arrived and the socket is still open. */
	connected(): boolean;
	/** Last credential or protocol refusal the fleet closed the socket with, or null. */
	rejection(): CallbackRejection | null;
	/** Dial attempts so far (1 after start; grows on each redial). */
	dials(): number;
	/** Every down envelope received, in order (heartbeats and pair_ready excluded). */
	received(): CallbackEnvelope[];
	/** Push one daemon->fleet envelope on the live socket and return its wire seq; throws when not connected. */
	send(streamId: string, kind: CallbackEnvelope["kind"], payload: unknown): number;
	/**
	 * Like send, but the payload is the given JSON text verbatim (it may carry
	 * duplicate keys or whitespace JSON.stringify never writes). `padded`
	 * frames the envelope non-canonically (a space after `"payload":`).
	 */
	sendRaw(
		streamId: string,
		kind: CallbackEnvelope["kind"],
		payloadJson: string,
		opts?: { padded?: boolean },
	): number;
	/** Drop the socket (network loss); the daemon redials on a fresh connectionId. */
	dropLegs(): void;
	/** Resolves once connected(); rejects after timeoutMs or on a rejection. */
	waitConnected(timeoutMs?: number): Promise<void>;
	/** Stop dialing and close the socket. */
	stop(): Promise<void>;
}

/** Bun's WebSocket client with its upgrade-header options; the DOM lib types hide them. */
const BunWebSocket = WebSocket as unknown as new (
	url: string,
	options: Bun.WebSocketOptions,
) => Bun.WebSocket;
const HEARTBEAT_KIND = "heartbeat";
/** Refusals that end the session for good; every other close redials. */
const TERMINAL_REFUSALS: readonly CallbackErrorCode[] = [
	"unauthorized",
	"invalid_identity",
	"generation_obsolete",
	"proto_unsupported",
];

function isPairReady(env: CallbackEnvelope): boolean {
	if (env.streamId !== CALLBACK_TRANSPORT_STREAM_ID) return false;
	const p: unknown = env.payload;
	return typeof p === "object" && p !== null && "type" in p && p.type === CALLBACK_PAIR_READY_TYPE;
}

export function startCallbackDaemon(opts: CallbackDaemonOpts): CallbackDaemon {
	const wsUrl = `${opts.url.replace(/\/+$/, "").replace(/^http/, "ws")}${CALLBACK_WS_PATH}`;
	const minMs = opts.redialMinMs ?? 25;
	const maxMs = opts.redialMaxMs ?? 250;

	let stopped = false;
	let paired = false;
	let connectionId = "";
	let upSeq = 0;
	let dialCount = 0;
	let rejected: CallbackRejection | null = null;
	let socket: Bun.WebSocket | null = null;
	const seen: CallbackEnvelope[] = [];

	/** One dial: the socket's whole life. Resolves when it closes (or fails to open). */
	const dialOnce = (): Promise<void> => {
		dialCount += 1;
		connectionId = randomUUID();
		upSeq = 0;
		const ws = new BunWebSocket(wsUrl, {
			headers: {
				"x-omp-workspace-id": opts.workspaceId,
				"x-omp-generation": String(opts.generation),
				"x-omp-connection-id": connectionId,
				authorization: `Bearer ${opts.token}`,
				[CALLBACK_PROTO_HEADER]: String(OMP_CALLBACK_PROTO),
			},
		});
		socket = ws;
		const { promise, resolve } = Promise.withResolvers<void>();
		ws.addEventListener("message", (event) => {
			const { data } = event as unknown as MessageEvent<string | ArrayBuffer>;
			if (typeof data !== "string") throw new Error("callback daemon got a binary message");
			const env = decodeEnvelope(data);
			if (isPairReady(env)) paired = true;
			else if (env.kind !== HEARTBEAT_KIND) seen.push(env);
		});
		ws.addEventListener("close", (event) => {
			paired = false;
			socket = null;
			const refusal = callbackErrorFromClose(event.code, event.reason);
			if (refusal !== null && TERMINAL_REFUSALS.includes(refusal.code)) {
				rejected = { status: CALLBACK_ERROR_HTTP_STATUS[refusal.code], error: refusal.code };
			}
			resolve();
		});
		return promise;
	};

	const loop = (async () => {
		let backoff = minMs;
		while (!stopped) {
			await dialOnce();
			if (stopped || rejected !== null) return;
			await Bun.sleep(backoff);
			backoff = Math.min(backoff * 2, maxMs);
		}
	})();

	const live = (): Bun.WebSocket | null =>
		paired && socket?.readyState === WebSocket.OPEN ? socket : null;

	return {
		get connectionId() {
			return connectionId;
		},
		connected: () => live() !== null,
		rejection: () => rejected,
		dials: () => dialCount,
		received: () => seen.slice(),
		send(streamId, kind, payload) {
			const ws = live();
			if (ws === null) throw new Error("callback daemon is not connected");
			upSeq += 1;
			const envelope: CallbackEnvelope = {
				version: OMP_CALLBACK_PROTO,
				workspaceId: opts.workspaceId,
				generation: opts.generation,
				connectionId,
				streamId,
				seq: upSeq,
				kind,
				payload,
				at: Date.now(),
			};
			ws.send(JSON.stringify(envelope));
			return upSeq;
		},
		sendRaw(streamId, kind, payloadJson, rawOpts) {
			const ws = live();
			if (ws === null) throw new Error("callback daemon is not connected");
			upSeq += 1;
			const { head, tail } = envelopeFraming({
				version: OMP_CALLBACK_PROTO,
				workspaceId: opts.workspaceId,
				generation: opts.generation,
				connectionId,
				streamId,
				seq: upSeq,
				kind,
				at: Date.now(),
			});
			ws.send((rawOpts?.padded === true ? `${head} ` : head) + payloadJson + tail);
			return upSeq;
		},
		dropLegs() {
			socket?.close();
		},
		async waitConnected(timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (live() !== null) return;
				if (rejected !== null) {
					throw new Error(`callback daemon rejected: ${rejected.status} ${rejected.error}`);
				}
				if (Date.now() >= deadline)
					throw new Error(`callback daemon not connected within ${timeoutMs}ms`);
				await Bun.sleep(10);
			}
		},
		async stop() {
			stopped = true;
			socket?.close();
			await loop;
		},
	};
}
