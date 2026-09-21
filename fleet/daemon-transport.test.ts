/**
 * Fleet-side callback transport (P3.3) controlled-peer regressions over the
 * REAL DaemonTransportRegistry: either-half close vs pair observation,
 * reconnect/renewal resume inside the replay ring without duplicate
 * acceptance, stale/revoked-generation rejection, bounded + isolated virtual
 * streams, bounded down delivery, and bulk multi-part sequencing. Every
 * scenario drives the actual registry over real loopback HTTP with controlled
 * daemon halves (one long-lived NDJSON up POST + one long-lived SSE down GET),
 * no mock transport, no source assertions. Each test owns its
 * registry/server and cleans up in a finally.
 *
 * Harness notes (verified against the real wire):
 * - #handleUp reads the POST body to completion, so the up Response is the
 *   END-of-up signal; tests hold a ReadableStream body open and close it to
 *   end a leg.
 * - The fleet re-delivers pair_ready on every (up/down) establishment, and a
 *   redial replays ring entries at their ORIGINAL down seqs, so a resumed
 *   consumer dedups by (connectionId, seq); a command is never re-accepted
 *   under a fresh seq.
 * - A daemon-side drop of either leg is NOT observed as pair loss: the fleet
 *   keeps the surviving half live and expects the daemon to redial the lost
 *   half on the same connectionId (the ring then replays the gap). paired:
 *   false is reserved for registry-internal teardown (revocation, the
 *   down-stream byte cap, or close()); ending the UP half alone leaves the
 *   down delivery path live.
 *
 * Timers: these are integration tests over real HTTP/SSE state; fake timers
 * cannot advance Bun's network stack, so the suite follows the repo's
 * poll-until-observable waitFor idiom and bounds every deadline. The slow
 * sink's delay is the deliberate stall under test.
 */
import { describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
	BULK_FINAL_HEADER,
	BULK_PART_HEADER,
	CALLBACK_BULK_PATH_PREFIX,
	CALLBACK_DOWN_PATH,
	CALLBACK_UP_PATH,
	encodeNdjsonLine,
	parseSseEnvelope,
	STREAM_MAX_BYTES,
	type CallbackEnvelope,
} from "../shared/callback-protocol";
import { DaemonTransportRegistry } from "./daemon-transport";

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

/**
 * Poll an observable wire/registry condition until it yields a value or the
 * deadline passes. Real HTTP I/O has no event to await for most of these
 * transitions (the registry exposes no completion callback for delivery),
 * so polling a bounded deadline is the deterministic idiom (shared with the
 * edge/fanout suites).
 */
async function waitFor<T>(
	probe: () => T | undefined,
	timeoutMs: number,
	label: string,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label} (${timeoutMs}ms)`);
		await sleep(20);
	}
}

interface Fixture {
	registry: DaemonTransportRegistry;
	url: string;
	stop(): void;
}

/** Mount one registry on an ephemeral loopback port. Bun's default server
 * idleTimeout closes long-lived request sockets after 10s of write
 * inactivity; the callback DOWN leg is a long-lived SSE stream whose first
 * write may lag (pair_ready rides the up leg), and the byte-cap teardown
 * test deliberately stalls a reader. 255s keeps the socket alive for the
 * duration of any test here. */
function serve(registry: DaemonTransportRegistry): Fixture {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		fetch: async (req) =>
			(await registry.handleFetch(req)) ?? new Response("not found", { status: 404 }),
	});
	return {
		registry,
		url: `http://127.0.0.1:${server.port}`,
		stop: () => {
			// Close the registry FIRST: it cancels in-flight up bodies (each
			// handler settles with a typed response) and closes down stream
			// controllers, so every client fetch settles before the server is
			// torn down; no dangling promises, no unhandled rejections.
			registry.close();
			server.stop(true);
		},
	};
}

const wireHeaders = (
	ws: string,
	gen: number,
	connId: string,
	cred: string,
): Record<string, string> => ({
	"x-omp-workspace-id": ws,
	"x-omp-generation": String(gen),
	"x-omp-connection-id": connId,
	authorization: `Bearer ${cred}`,
});

/** Narrowed payload field read: envelope payloads are validated `unknown`. */
function payloadField(env: CallbackEnvelope, key: "id" | "type"): unknown {
	const p = env.payload;
	if (p === null || typeof p !== "object") return undefined;
	if (key === "id") {
		return "id" in p ? (p as Record<string, unknown>).id : undefined;
	}
	return "type" in p ? (p as Record<string, unknown>).type : undefined;
}

const pairReady = (env: CallbackEnvelope): boolean => payloadField(env, "type") === "pair_ready";
const commandId = (env: CallbackEnvelope): unknown => payloadField(env, "id");

/** One controlled daemon upload leg: an open NDJSON POST body. */
interface UpLeg {
	/** Push one daemon->fleet envelope; the registry stamps nothing (up seq is the daemon's). */
	push(streamId: string, kind: CallbackEnvelope["kind"], payload: unknown): void;
	/** End the upload body; resolves with the registry's end-of-up response. */
	end(): Promise<{ status: number; body: unknown }>;
}

function openUp(fixture: Fixture, ws: string, gen: number, connId: string, cred: string): UpLeg {
	let upSeq = 0;
	let upCtrl!: ReadableStreamDefaultController<Uint8Array>;
	const upBody = new ReadableStream<Uint8Array>({ start: (c) => (upCtrl = c) });
	const encoder = new TextEncoder();
	// Guarded: when the peer's down drop or a revocation kills the shared
	// socket, Bun rejects this fetch; the guard keeps it from surfacing as an
	// unhandled rejection before end() observes it.
	const upResponse = fetch(`${fixture.url}${CALLBACK_UP_PATH}`, {
		method: "POST",
		headers: wireHeaders(ws, gen, connId, cred),
		body: upBody,
	}).catch(() => null);
	return {
		push(streamId, kind, payload) {
			upSeq += 1;
			const envelope: CallbackEnvelope = {
				version: 1,
				workspaceId: ws,
				generation: gen,
				connectionId: connId,
				streamId,
				seq: upSeq,
				kind,
				payload,
				at: Date.now(),
			};
			upCtrl.enqueue(encoder.encode(encodeNdjsonLine(envelope)));
		},
		async end() {
			try {
				upCtrl.close();
			} catch {
				// The registry already cancelled the body (e.g. revocation
				// killed this upload leg); the response settles on its own.
			}
			const res = await upResponse;
			if (res === null) return { status: 503, body: { error: "unavailable" } };
			const body: unknown = await res.json();
			return { status: res.status, body };
		},
	};
}

/** One controlled daemon downlink: a GET /callback/down SSE body. */
interface DownLeg {
	/** Envelopes observed on the live stream, in order. */
	seen(): CallbackEnvelope[];
	/** Drop the downlink (daemon-side network loss / abort). */
	drop(): void;
	/** Resolves when the registry closes the stream body (teardown), else rejects on deadline. */
	ended(timeoutMs?: number): Promise<void>;
}

async function openDown(
	fixture: Fixture,
	ws: string,
	gen: number,
	connId: string,
	cred: string,
	lastEventId?: number,
): Promise<DownLeg> {
	const response = await fetch(`${fixture.url}${CALLBACK_DOWN_PATH}`, {
		headers: {
			...wireHeaders(ws, gen, connId, cred),
			...(lastEventId !== undefined ? { "Last-Event-ID": String(lastEventId) } : {}),
		},
	});
	if (!response.ok || !response.body) throw new Error(`down dial -> HTTP ${response.status}`);
	// Bun types the fetch body as ReadableStream<Uint8Array<ArrayBuffer>>;
	// the shared parser accepts ReadableStream<Uint8Array<ArrayBufferLike>>.
	// Hoisting through an untyped const widens to the assignable form.
	const body = response.body as ReadableStream<Uint8Array>;
	const observed: CallbackEnvelope[] = [];
	const readerDone = (async () => {
		try {
			for await (const env of parseSseEnvelope(body)) observed.push(env);
		} catch {
			// dropped/aborted/closed stream; callers observe via seen()/ended()
		}
	})();
	return {
		seen: () => observed,
		drop: () => {
			response.body!.cancel().catch(() => {});
		},
		ended: (timeoutMs = 3000) => {
			const { promise, resolve, reject } = Promise.withResolvers<void>();
			const timer = setTimeout(
				() => reject(new Error(`down stream did not end (${timeoutMs}ms)`)),
				timeoutMs,
			);
			readerDone.then(
				() => {
					clearTimeout(timer);
					resolve();
				},
				() => {
					// parseSseEnvelope rejected because the registry closed the
					// stream (teardown); that is the end the caller awaits.
					clearTimeout(timer);
					resolve();
				},
			);
			return promise;
		},
	};
}

async function expectUnavailable(p: Promise<unknown>): Promise<void> {
	await expect(p).rejects.toMatchObject({ code: "unavailable" });
}

/** Dial the down link and keep reading it SLOWLY: a daemon whose receive
 * side cannot keep up with the fleet. The registry must bound the buffered
 * bytes and tear the connection down (drop-and-resume) rather than grow
 * without limit.
 *
 * A down-only dial registers the connection immediately (pairStatus().paired
 * goes true) but writes no envelope until a heartbeat or a send, so
 * readiness is observed via pairStatus, not wire data. The reader drains one
 * chunk per tick: slow enough that a flood crosses the 8 MiB per-connection
 * buffer bound, fast enough that the socket is never idle-killed. */
function openSlowDown(
	fixture: Fixture,
	ws: string,
	gen: number,
	connId: string,
	cred: string,
): { ready(timeoutMs?: number): Promise<void> } {
	const headers = wireHeaders(ws, gen, connId, cred);
	const p = fetch(`${fixture.url}${CALLBACK_DOWN_PATH}`, { headers });
	p.then((res) => {
		if (!res.ok || !res.body) return;
		const reader = res.body.getReader();
		// Slow continuous drain. When the registry tears the connection down
		// at the buffer bound, Bun rejects the fetch/read; every path is
		// handled so a teardown never surfaces as an unhandled rejection.
		(async () => {
			try {
				for (;;) {
					const { done } = await reader.read();
					if (done) break;
					await sleep(50);
				}
			} catch {
				// teardown close; the test observes via registry state
			}
		})();
	}).catch(() => {});
	return {
		async ready(timeoutMs = 5000): Promise<void> {
			const deadline = Date.now() + timeoutMs;
			while (!fixture.registry.pairStatus(ws).paired && Date.now() < deadline) {
				await sleep(20);
			}
			if (!fixture.registry.pairStatus(ws).paired) {
				throw new Error(`down dial never paired (${timeoutMs}ms)`);
			}
		},
	};
}

describe("daemon transport controlled pairs", () => {
	test("either-half close: up-end alone keeps delivering; a full redial resumes the ring without duplicate acceptance", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-half-close";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, gen, cred);
		try {
			const up = openUp(fixture, ws, gen, connId, cred);
			const down = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down.seen().find(pairReady), 2000, "pair_ready");
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);

			// A fleet command lands on the down ring.
			const c1 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c1" },
			});
			await waitFor(() => down.seen().find((e) => e.seq === c1.seq), 2000, "c1 delivery");

			// The daemon ends ONLY its upload leg (clean close). The fleet does
			// not invalidate: the down delivery path stays live and a new
			// command still flows at a fresh seq.
			expect((await up.end()).status).toBe(200);
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			const c2 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c2" },
			});
			expect(c2.seq).toBeGreaterThan(c1.seq);
			await waitFor(
				() => down.seen().find((e) => e.seq === c2.seq),
				2000,
				"c2 delivery after up-end",
			);

			// The daemon then loses the DOWN half and redials BOTH halves on
			// the same connectionId (renewal). The pre-drop commands replay
			// at their ORIGINAL seqs; each exactly once, never re-rung under
			// a fresh identity.
			down.drop();
			const up2 = openUp(fixture, ws, gen, connId, cred);
			const down2 = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down2.seen().find(pairReady), 2000, "pair_ready after redial");
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			const c1Replay = down2.seen().filter((e) => commandId(e) === "c1");
			const c2Replay = down2.seen().filter((e) => commandId(e) === "c2");
			expect(c1Replay).toHaveLength(1);
			expect(c2Replay).toHaveLength(1);
			expect(c1Replay[0].seq).toBe(c1.seq);
			expect(c2Replay[0].seq).toBe(c2.seq);
			const c3 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c3" },
			});
			expect(c3.seq).toBeGreaterThan(c2.seq);
			await waitFor(() => down2.seen().find((e) => e.seq === c3.seq), 2000, "c3 delivery");
			expect((await up2.end()).status).toBe(200);
		} finally {
			fixture.stop();
		}
	});

	test("a down-half-only redial recovers on the same up leg and replays at original seqs without duplicate acceptance", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-down-half";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, gen, cred);
		try {
			const up = openUp(fixture, ws, gen, connId, cred);
			const down = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down.seen().find(pairReady), 2000, "pair_ready");
			const c1 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c1" },
			});
			await waitFor(() => down.seen().find((e) => e.seq === c1.seq), 2000, "c1 delivery");

			// One-sided network loss: only the down link dies; the upload leg
			// survives untouched. The daemon redials ONLY the down link; the
			// still-live up leg re-announces the pair and the ring replays
			// the unacked command at its original seq exactly once.
			down.drop();
			const down2 = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down2.seen().find(pairReady), 2000, "pair_ready after down redial");
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			const c1Replay = down2.seen().filter((e) => commandId(e) === "c1");
			expect(c1Replay).toHaveLength(1);
			expect(c1Replay[0].seq).toBe(c1.seq);
			const c2 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c2" },
			});
			expect(c2.seq).toBeGreaterThan(c1.seq);
			await waitFor(() => down2.seen().find((e) => e.seq === c2.seq), 2000, "c2 delivery");
			// The original upload leg was never killed: it ends cleanly with
			// the registry's own ack (received 0, no up envelopes were sent).
			const ended = await up.end();
			expect(ended.status).toBe(200);
			expect(ended.body).toMatchObject({ ok: true });
		} finally {
			fixture.stop();
		}
	});

	test("redial replays the full ring at original seqs; a Last-Event-ID resume skips only the acked prefix", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-replay";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, gen, cred);
		try {
			const up = openUp(fixture, ws, gen, connId, cred);
			const first = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => first.seen().find(pairReady), 2000, "pair_ready");
			const a = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "a" },
			});
			await waitFor(() => first.seen().find((e) => e.seq === a.seq), 2000, "a delivery");

			// Loss without a resume point: the daemon redials blind (no
			// Last-Event-ID) and the WHOLE ring replays; command `a` returns
			// under its original seq, the identity a deduping consumer keys on.
			first.drop();
			const blind = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(
				() => blind.seen().find((e) => commandId(e) === "a"),
				2000,
				"blind replay of a",
			);
			const blindReplay = blind.seen().filter((e) => commandId(e) === "a");
			expect(blindReplay).toHaveLength(1);
			expect(blindReplay[0].seq).toBe(a.seq);

			// Acknowledged resume: Last-Event-ID = a.seq skips the acked
			// prefix entirely; `a` is not re-delivered, later traffic is.
			const acked = await openDown(fixture, ws, gen, connId, cred, a.seq);
			await waitFor(() => acked.seen().find(pairReady), 2000, "pair_ready on acked resume");
			const b = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "b" },
			});
			await waitFor(() => acked.seen().find((e) => e.seq === b.seq), 2000, "b delivery");
			expect(acked.seen().some((e) => commandId(e) === "a")).toBe(false);
			expect(acked.seen().some((e) => commandId(e) === "b")).toBe(true);
			expect((await up.end()).status).toBe(200);
		} finally {
			fixture.stop();
		}
	});

	test("stale and revoked generations are denied on every leg; revocation tears down the live pair", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		// Revocation lifecycle (what workspace-lifecycle does before renewal):
		// revoke the old generation, then enroll the new one.
		const wsA = "ws-revoke";
		const cred1 = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(wsA, 1, cred1);
		try {
			const g1Conn = randomUUID();
			const g1up = openUp(fixture, wsA, 1, g1Conn, cred1);
			const g1down = await openDown(fixture, wsA, 1, g1Conn, cred1);
			await waitFor(() => g1down.seen().find(pairReady), 2000, "gen1 pair_ready");
			expect(fixture.registry.pairStatus(wsA).paired).toBe(true);

			// Revoking the only generation tears BOTH halves down: the down
			// body ends on the wire and commands stop being accepted.
			fixture.registry.revokeEnrollment(wsA, 1);
			await waitFor(
				() => (fixture.registry.pairStatus(wsA).paired ? undefined : true),
				2000,
				"paired:false after revoke",
			);
			await expectUnavailable(
				fixture.registry.sendToDaemon(wsA, {
					streamId: "control",
					kind: "command",
					payload: {},
				}),
			);
			await g1down.ended(2000);
			// The killed upload leg answers typed unavailable (platform abort).
			expect((await g1up.end()).status).toBe(503);

			// Renewal at generation 2: new pair, commands stamped gen 2.
			const cred2 = randomBytes(32).toString("hex");
			fixture.registry.enrollWorkspace(wsA, 2, cred2);
			const g2Conn = randomUUID();
			const g2up = openUp(fixture, wsA, 2, g2Conn, cred2);
			const g2down = await openDown(fixture, wsA, 2, g2Conn, cred2);
			await waitFor(() => g2down.seen().find(pairReady), 2000, "gen2 pair_ready");
			const cmd = await fixture.registry.sendToDaemon(wsA, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "gen2" },
			});
			expect(cmd.generation).toBe(2);
			await waitFor(() => g2down.seen().find((e) => e.seq === cmd.seq), 2000, "gen2 delivery");

			// The revoked gen-1 credential is now denied outright (401, the
			// record is gone, so no existence oracle).
			const stale = await fetch(`${fixture.url}${CALLBACK_UP_PATH}`, {
				method: "POST",
				headers: wireHeaders(wsA, 1, randomUUID(), cred1),
				body: "",
			});
			expect(stale.status).toBe(401);
			fixture.registry.revokeEnrollment(wsA, 2);
			await waitFor(
				() => (fixture.registry.pairStatus(wsA).paired ? undefined : true),
				2000,
				"paired:false after gen2 revoke",
			);
		} finally {
			fixture.stop();
		}
	});

	test("superseded-generation credentials get the actionable 409, unknown credentials 401, on up and down legs", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-obsolete";
		const cred1 = randomBytes(32).toString("hex");
		const cred2 = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred1);
		fixture.registry.enrollWorkspace(ws, 2, cred2); // supersede without revoke
		try {
			// Verified but stale (gen 1 while gen 2 is authorized): the
			// actionable 409, both legs.
			const staleUp = await fetch(`${fixture.url}${CALLBACK_UP_PATH}`, {
				method: "POST",
				headers: wireHeaders(ws, 1, randomUUID(), cred1),
				body: "",
			});
			expect(staleUp.status).toBe(409);
			const staleBody: unknown = await staleUp.json();
			expect(staleBody).toMatchObject({ error: "generation_obsolete" });
			const staleDown = await fetch(`${fixture.url}${CALLBACK_DOWN_PATH}`, {
				headers: wireHeaders(ws, 1, randomUUID(), cred1),
			});
			expect(staleDown.status).toBe(409);

			// An unknown credential at the current generation: plain 401 (no
			// existence oracle), not a generation verdict.
			const wrongCred = await fetch(`${fixture.url}${CALLBACK_UP_PATH}`, {
				method: "POST",
				headers: wireHeaders(ws, 1, randomUUID(), randomBytes(32).toString("hex")),
				body: "",
			});
			expect(wrongCred.status).toBe(401);
			const wrongCred2 = await fetch(`${fixture.url}${CALLBACK_UP_PATH}`, {
				method: "POST",
				headers: wireHeaders(ws, 2, randomUUID(), cred1), // gen-1 secret on gen 2
				body: "",
			});
			expect(wrongCred2.status).toBe(401);

			// The current generation still works on both legs. The up leg
			// answers 200 directly; the down leg is a long-lived SSE stream
			// whose fetch only resolves once data flows (a down-only dial
			// writes nothing until a heartbeat), so its acceptance is
			// observed via the registry pairing the connection.
			const okUp = await fetch(`${fixture.url}${CALLBACK_UP_PATH}`, {
				method: "POST",
				headers: wireHeaders(ws, 2, randomUUID(), cred2),
				body: "",
			});
			expect(okUp.status).toBe(200);
			const okConn = randomUUID();
			const okDownFetch = fetch(`${fixture.url}${CALLBACK_DOWN_PATH}`, {
				headers: wireHeaders(ws, 2, okConn, cred2),
			});
			okDownFetch.catch(() => {}); // teardown close at test end; guarded
			await waitFor(
				() => (fixture.registry.pairStatus(ws).paired ? true : undefined),
				2000,
				"gen-2 down dial paired",
			);
			expect(fixture.registry.pairStatus(ws).connectionId).toBe(okConn);
			okDownFetch.then((res) => res.body?.cancel().catch(() => {})).catch(() => {});
		} finally {
			fixture.stop();
		}
	});

	test("bulk multi-part uploads concatenate exactly once; holes, out-of-order starts, and reuse fail the whole transfer without data", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-bulk";
		const wsOther = "ws-bulk-other";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		fixture.registry.enrollWorkspace(wsOther, 1, cred);
		const H = wireHeaders(ws, 1, randomUUID(), cred);
		const bulkUrl = (corr: { correlationId: string }): string =>
			`${fixture.url}${CALLBACK_BULK_PATH_PREFIX}${corr.correlationId}`;
		const postPart = (
			url: string,
			headers: Record<string, string>,
			part?: number,
			final?: boolean,
			body = "",
		): Promise<Response> =>
			fetch(url, {
				method: "POST",
				headers: {
					...headers,
					...(part !== undefined ? { [BULK_PART_HEADER]: String(part) } : {}),
					...(final !== undefined ? { [BULK_FINAL_HEADER]: final ? "1" : "0" } : {}),
				},
				body,
			});
		try {
			// Happy sequential parts: part 0 (intermediate) then part 1 (final)
			// concatenate into exactly the original payload.
			const good = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const p0 = await postPart(bulkUrl(good), H, 0, false, "hello ");
			expect(p0.status).toBe(200);
			const p0Body: unknown = await p0.json();
			expect(p0Body).toMatchObject({ status: "part_received" });
			const p1 = await postPart(bulkUrl(good), H, 1, true, "world");
			expect(p1.status).toBe(200);
			const goodResult = await good.done;
			expect(goodResult.state).toBe("received");
			expect(goodResult.bytes).toBe(11);
			expect(Buffer.from(goodResult.data as Uint8Array).toString("utf8")).toBe("hello world");

			// Reuse of a settled correlation is refused (single-use ids).
			const reuse = await postPart(bulkUrl(good), H, 2, true, "again");
			expect(reuse.status).toBe(409);

			// A hole in the sequence (0 then 2): the transfer fails as a
			// whole; correlation settles failed and serves no bytes.
			const hole = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const h0 = await postPart(bulkUrl(hole), H, 0, false, "aaa");
			expect(h0.status).toBe(200);
			const h2 = await postPart(bulkUrl(hole), H, 2, true, "ccc");
			expect(h2.status).toBe(409);
			const holeResult = await hole.done;
			expect(holeResult.state).toBe("failed");
			expect(holeResult.data).toBeUndefined();

			// An out-of-order FIRST part (1 on a fresh correlation) is
			// rejected the same way; no corrupt prefix is ever buffered.
			const ooo = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const o1 = await postPart(bulkUrl(ooo), H, 1, true, "zzz");
			expect(o1.status).toBe(409);
			const oooResult = await ooo.done;
			expect(oooResult.state).toBe("failed");
			expect(oooResult.data).toBeUndefined();

			// A part-less POST is the implicit single-shot transfer.
			const single = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const s0 = await postPart(bulkUrl(single), H, undefined, undefined, "single-shot");
			expect(s0.status).toBe(200);
			const singleResult = await single.done;
			expect(singleResult.state).toBe("received");
			expect(Buffer.from(singleResult.data as Uint8Array).toString("utf8")).toBe("single-shot");

			// Correlations are workspace-scoped: a foreign workspace's upload
			// is rejected (400 unknown correlation) and leaves the record
			// INTACT; the owner still completes it untouched.
			const foreign = fixture.registry.createBulkCorrelation(wsOther, { capture: true });
			const x = await postPart(bulkUrl(foreign), H, 0, true, "steal");
			expect(x.status).toBe(400);
			const xBody: unknown = await x.json();
			expect(xBody).toMatchObject({ error: "invalid_request" });
			// The owner's own upload still lands with exactly its bytes.
			const owner = await postPart(
				bulkUrl(foreign),
				wireHeaders(wsOther, 1, randomUUID(), cred),
				0,
				true,
				"legit",
			);
			expect(owner.status).toBe(200);
			const foreignResult = await foreign.done;
			expect(foreignResult.state).toBe("received");
			expect(foreignResult.bytes).toBe(5);
			expect(Buffer.from(foreignResult.data as Uint8Array).toString("utf8")).toBe("legit");
		} finally {
			fixture.stop();
		}
	});

	test("slow virtual stream is bounded at the per-stream cap with drops, while controls and a sibling workspace stay unstarved", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const wsSlow = "ws-slow-sink";
		const wsOther = "ws-other-sink";
		const gen = 1;
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(wsSlow, gen, cred);
		fixture.registry.enrollWorkspace(wsOther, gen, cred);
		try {
			// Workspace 1: slow sink under a fat frame flood.
			const ws1Conn = randomUUID();
			const up1 = openUp(fixture, wsSlow, gen, ws1Conn, cred);
			const down1 = await openDown(fixture, wsSlow, gen, ws1Conn, cred);
			await waitFor(() => down1.seen().find(pairReady), 2000, "pair_ready wsSlow");

			const slowDelivered: CallbackEnvelope[] = [];
			const backpressures: Array<{ dropped: number; queuedBytes: number }> = [];
			const slow = {
				async deliver(e: CallbackEnvelope): Promise<void> {
					slowDelivered.push(e);
					// Deliberately slower than the arrival rate so the queue
					// saturates: a real stall needs real time.
					await sleep(100);
				},
				onBackpressure(info: { dropped: number; queuedBytes: number }): void {
					backpressures.push(info);
				},
			};
			fixture.registry.attachVirtualStream(wsSlow, "stream/slow", slow);
			const fastDelivered: CallbackEnvelope[] = [];
			fixture.registry.attachVirtualStream(wsSlow, "stream/fast", {
				async deliver(e: CallbackEnvelope): Promise<void> {
					fastDelivered.push(e);
				},
			});
			const ctlDelivered: CallbackEnvelope[] = [];
			fixture.registry.attachVirtualStream(wsSlow, "control", {
				async deliver(e: CallbackEnvelope): Promise<void> {
					ctlDelivered.push(e);
				},
			});

			// 40 x ~190KB frames (~7.6 MiB on the wire, under the 8 MiB up
			// connection cap) against a 4 MiB per-stream bound.
			for (let i = 0; i < 40; i++) {
				up1.push("stream/slow", "frame", { type: "history", blob: "x".repeat(190_000), i });
			}
			// The pump saturates the slow stream's queue and must drop.
			await waitFor(
				() => (backpressures.length > 0 ? backpressures[0] : undefined),
				4000,
				"backpressure",
			);
			const saturated = fixture.registry.pairStatus(wsSlow);
			const slowStatus = saturated.streams.find((s) => s.streamId === "stream/slow");
			expect(slowStatus).toBeDefined();
			expect(slowStatus!.queuedBytes).toBeLessThanOrEqual(STREAM_MAX_BYTES);
			expect(slowStatus!.dropped).toBeGreaterThan(0);
			expect(slowStatus!.queued + slowDelivered.length).toBeLessThan(40);

			// Commands that arrive while the queue is pinned are still
			// drained (control always precedes frames); nothing is starved.
			for (let i = 0; i < 8; i++) {
				up1.push("control", "command", { type: "cmd", id: `c${i}` });
			}
			await waitFor(
				() => (ctlDelivered.length === 8 ? true : undefined),
				3000,
				"all 8 commands delivered",
			);
			// Sibling stream in the same workspace: untouched by the flood.
			const fastStatus = saturated.streams.find((s) => s.streamId === "stream/fast");
			expect(fastStatus?.queuedBytes ?? 0).toBe(0);
			expect(fastStatus?.dropped ?? 0).toBe(0);
			expect(fastDelivered.length).toBe(0);

			// Workspace 2: its own pair + pump must not wait on workspace 1's
			// parked sink. Attach after ws1's flood so any delay would show.
			const ws2Conn = randomUUID();
			const up2 = openUp(fixture, wsOther, gen, ws2Conn, cred);
			const down2 = await openDown(fixture, wsOther, gen, ws2Conn, cred);
			await waitFor(() => down2.seen().find(pairReady), 2000, "pair_ready wsOther");
			const otherDelivered: CallbackEnvelope[] = [];
			fixture.registry.attachVirtualStream(wsOther, "control", {
				async deliver(e: CallbackEnvelope): Promise<void> {
					otherDelivered.push(e);
				},
			});
			up2.push("control", "command", { type: "cmd", id: "other-1" });
			await waitFor(
				() => (otherDelivered.length === 1 ? true : undefined),
				2000,
				"wsOther command while wsSlow sink is parked",
			);
			const otherStatus = fixture.registry
				.pairStatus(wsOther)
				.streams.find((s) => s.streamId === "control");
			expect(otherStatus?.queued ?? 0).toBe(0);
			expect((await up1.end()).status).toBe(200);
			expect((await up2.end()).status).toBe(200);
		} finally {
			fixture.stop();
		}
	});

	test("a stalled down reader trips the bounded drop-and-resume teardown; the surviving ring replays without loss or duplication", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-down-bound";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, gen, cred);
		try {
			// A daemon whose downlink cannot keep up with the fleet: the
			// registry must bound the buffered bytes and tear the connection
			// down (drop-and-resume) rather than grow without limit. No up
			// leg; the ring and down delivery are the subject.
			const stalled = await openSlowDown(fixture, ws, gen, connId, cred);
			await stalled.ready();
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);

			// Flood 500KB frames; the stalled reader lets the server-side
			// buffer cross the 8 MiB per-connection bound.
			const sentSeqs: number[] = [];
			const floodPayload = { type: "frame", blob: "y".repeat(500_000) };
			for (let i = 0; i < 80; i++) {
				try {
					const env = await fixture.registry.sendToDaemon(ws, {
						streamId: "browser/x",
						kind: "frame",
						payload: floodPayload,
					});
					sentSeqs.push(env.seq);
				} catch {
					break; // the registry refused further sends
				}
				if (!fixture.registry.pairStatus(ws).paired) break;
			}
			// The connection must be dropped once buffering hit the cap
			// (never an unbounded accept): paired flips false.
			await waitFor(
				() => (fixture.registry.pairStatus(ws).paired ? undefined : true),
				6000,
				"drop-and-resume teardown",
			);
			expect(sentSeqs.length).toBeGreaterThan(0);
			// Nothing further is accepted while unpaired.
			await expectUnavailable(
				fixture.registry.sendToDaemon(ws, {
					streamId: "browser/x",
					kind: "frame",
					payload: floodPayload,
				}),
			);

			// The replay ring survived the teardown AND stayed byte-bounded:
			// head entries were evicted, so the depth is below the send count.
			const ringDepth = fixture.registry.pairStatus(ws).replayDepth;
			expect(ringDepth).toBeGreaterThan(0);
			expect(ringDepth).toBeLessThan(sentSeqs.length);

			// Redial: the daemon resumes (blind, it read nothing past the
			// pair_ready). Replay is strictly ascending, duplicate-free, and
			// ends at the last sent seq; no loss past the resume point, no
			// duplicated ring entries.
			const redial = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(
				() => redial.seen().find((e) => e.seq === sentSeqs.at(-1)),
				3000,
				"redial replays the newest envelope",
			);
			const replayed = redial.seen();
			expect(replayed.length).toBeGreaterThan(0);
			const seqs = replayed.map((e) => e.seq);
			for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
			expect(new Set(seqs).size).toBe(seqs.length);
			expect(seqs.at(-1)).toBe(sentSeqs.at(-1));
			expect(seqs.every((s) => s <= sentSeqs.at(-1)!)).toBe(true);
			redial.drop();
		} finally {
			fixture.stop();
		}
	});
});
