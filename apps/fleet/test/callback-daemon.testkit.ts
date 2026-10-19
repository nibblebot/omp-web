/**
 * Shared controlled daemon for the fleet suites: a session-side callback pair
 * (one long-lived NDJSON POST /callback/up upload + one long-lived SSE GET
 * /callback/down downlink) dialed OUT to a real DaemonTransportRegistry over
 * loopback HTTP, exactly as apps/session/fleet-callback.ts dials it. The
 * fleet never dials the daemon, so this fake only ever dials.
 *
 * Behaviour mirrors the daemon half: the pair is live once pair_ready arrives
 * on the down leg; a dropped leg (network loss) or a transport error redials
 * the SAME connectionId and credential after a backoff, so the fleet ring
 * replays the gap; a 401 or 409 rejection (unknown/revoked credential,
 * superseded generation) records the status and stops redialing, the way a
 * real session shuts down.
 */
import { randomUUID } from "node:crypto";
import {
	CALLBACK_DOWN_PATH,
	CALLBACK_PAIR_READY_TYPE,
	CALLBACK_TRANSPORT_STREAM_ID,
	CALLBACK_UP_PATH,
	type CallbackEnvelope,
	encodeNdjsonLine,
	parseSseEnvelope,
} from "#lib/wire/callback-protocol";

export interface CallbackDaemonOpts {
	/** Fleet callback base URL, no /callback suffix (the --fleet-stdin callback.url). */
	url: string;
	workspaceId: string;
	generation: number;
	/** 64-hex enrollment credential (the --fleet-stdin callback.token). */
	token: string;
	connectionId?: string;
	/** Initial redial backoff (doubles to redialMaxMs). Defaults 25ms / 250ms. */
	redialMinMs?: number;
	redialMaxMs?: number;
}

export interface CallbackRejection {
	status: number;
	error: string;
}

export interface CallbackDaemon {
	readonly connectionId: string;
	/** Down leg received pair_ready and the up leg is still open. */
	connected(): boolean;
	/** Last 401/409 the fleet answered the credential with, or null. */
	rejection(): CallbackRejection | null;
	/** Dial attempts so far (1 after start; grows on each redial). */
	dials(): number;
	/** Every down envelope received, in order (heartbeats and pair_ready excluded). */
	received(): CallbackEnvelope[];
	/** Push one daemon->fleet envelope on the live up leg; throws when not connected. */
	send(streamId: string, kind: CallbackEnvelope["kind"], payload: unknown): void;
	/** Drop both legs (network loss); the daemon redials the same connectionId. */
	dropLegs(): void;
	/** Resolves once connected(); rejects after timeoutMs or on a rejection. */
	waitConnected(timeoutMs?: number): Promise<void>;
	/** Stop dialing and close both legs. */
	stop(): Promise<void>;
}

const HEARTBEAT_KIND = "heartbeat";

function isPairReady(env: CallbackEnvelope): boolean {
	if (env.streamId !== CALLBACK_TRANSPORT_STREAM_ID) return false;
	const p: unknown = env.payload;
	return typeof p === "object" && p !== null && "type" in p && p.type === CALLBACK_PAIR_READY_TYPE;
}

export function startCallbackDaemon(opts: CallbackDaemonOpts): CallbackDaemon {
	const connectionId = opts.connectionId ?? randomUUID();
	const base = opts.url.replace(/\/+$/, "");
	const headers: Record<string, string> = {
		"x-omp-workspace-id": opts.workspaceId,
		"x-omp-generation": String(opts.generation),
		"x-omp-connection-id": connectionId,
		authorization: `Bearer ${opts.token}`,
	};
	const minMs = opts.redialMinMs ?? 25;
	const maxMs = opts.redialMaxMs ?? 250;

	let stopped = false;
	let paired = false;
	let upSeq = 0;
	let dialCount = 0;
	let rejected: CallbackRejection | null = null;
	let up: ReadableStreamDefaultController<Uint8Array> | null = null;
	let abort: AbortController | null = null;
	const seen: CallbackEnvelope[] = [];
	const encoder = new TextEncoder();

	const noteRejection = async (res: Response): Promise<void> => {
		const body: unknown = await res.json().catch(() => ({}));
		const error =
			typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
		rejected = { status: res.status, error: typeof error === "string" ? error : "" };
	};

	/** One dial: both legs until either ends. Returns when the pair is torn down. */
	const dialOnce = async (): Promise<void> => {
		dialCount += 1;
		const ctl = new AbortController();
		abort = ctl;
		const down = fetch(`${base}${CALLBACK_DOWN_PATH}`, { headers, signal: ctl.signal })
			.then(async (res) => {
				if (res.status !== 200) {
					if (res.status === 401 || res.status === 409) await noteRejection(res);
					return;
				}
				if (res.body === null) return;
				for await (const env of parseSseEnvelope(res.body)) {
					if (isPairReady(env)) {
						paired = true;
						continue;
					}
					if (env.kind === HEARTBEAT_KIND) continue;
					seen.push(env);
				}
			})
			.catch(() => {});
		const upLeg = fetch(`${base}${CALLBACK_UP_PATH}`, {
			method: "POST",
			headers,
			signal: ctl.signal,
			body: new ReadableStream<Uint8Array>({ start: (c) => (up = c) }),
		})
			.then(async (res) => {
				if (res.status === 401 || res.status === 409) await noteRejection(res);
			})
			.catch(() => {});
		await Promise.race([down, upLeg]);
		ctl.abort();
		await Promise.allSettled([down, upLeg]);
		paired = false;
		up = null;
		abort = null;
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

	return {
		connectionId,
		connected: () => paired && up !== null,
		rejection: () => rejected,
		dials: () => dialCount,
		received: () => seen.slice(),
		send(streamId, kind, payload) {
			const live = up;
			if (!paired || live === null) throw new Error("callback daemon is not connected");
			upSeq += 1;
			const envelope: CallbackEnvelope = {
				version: 1,
				workspaceId: opts.workspaceId,
				generation: opts.generation,
				connectionId,
				streamId,
				seq: upSeq,
				kind,
				payload,
				at: Date.now(),
			};
			live.enqueue(encoder.encode(encodeNdjsonLine(envelope)));
		},
		dropLegs() {
			abort?.abort();
		},
		async waitConnected(timeoutMs = 5000) {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (paired && up !== null) return;
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
			abort?.abort();
			await loop;
		},
	};
}
