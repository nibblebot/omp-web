/**
 * Fleet-side callback transport controlled-peer regressions over the
 * REAL DaemonTransportRegistry: either-half close vs pair observation,
 * reconnect/renewal continuity (seq never reset, no replay), no duplicate
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
 * - The fleet re-delivers pair_ready on every (up/down) establishment. A redial
 *   on the same connectionId never replays earlier envelopes: seqs continue, so
 *   a consumer dedups by (connectionId, seq) and a command is never re-accepted.
 * - A daemon-side drop of either leg is NOT observed as pair loss: the fleet
 *   keeps the surviving half live and expects the daemon to redial the lost
 *   half on the same connectionId; that redial continues the seq space and
 *   replays nothing. paired: false is reserved for registry-internal teardown
 *   (revocation, the down-stream byte cap, or close()); ending the UP half
 *   alone leaves the down delivery path live.
 *
 * Timers: these are integration tests over real HTTP/SSE state; fake timers
 * cannot advance Bun's network stack, so the suite follows the repo's
 * poll-until-observable waitFor idiom and bounds every deadline. The slow
 * sink's delay is the deliberate stall under test. Deadline sweeps (up
 * silence, seq record idleness, bulk TTL) are driven through the registry's
 * injectable clock + sweep cadence (clockedRegistry), never by waiting out a
 * real 30 s / 10 min deadline.
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
	CONNECTION_MAX_BYTES,
	SILENCE_DEADLINE_MS,
	type CallbackEnvelope,
} from "#lib/wire/callback-protocol";
import { DaemonTransportRegistry } from "../daemon-transport";

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

/** Narrowed string field read off a parsed JSON body (unknown by contract). */
function bodyString(body: unknown, key: string): string | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const value = Object.entries(body).find(([name]) => name === key)?.[1];
	return typeof value === "string" ? value : undefined;
}

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
	/** Abort the socket (real one-sided network loss: the registry's stream
	 * cancel fires). Cancelling the response body instead would be a no-op
	 * while the SSE iterator holds the reader lock. */
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
): Promise<DownLeg> {
	const ctl = new AbortController();
	const response = await fetch(`${fixture.url}${CALLBACK_DOWN_PATH}`, {
		headers: wireHeaders(ws, gen, connId, cred),
		signal: ctl.signal,
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
 * The down leg is a pair only once an up half joins (FEDGE-14), so the
 * caller must hold an up leg for the same connection open. Readiness is
 * observed via pairStatus().paired, not wire data: the down leg writes no
 * envelope until pair_ready, a heartbeat, or a send. The reader drains one
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

/** SEQ_RECORD_IDLE_MS and BULK_IDLE_MS are module-private registry deadlines; the
 * swept tests advance past them explicitly. */
const SWEEP_TTL_MS = 10 * 60_000;

/** A registry with an injected clock and a fast sweep cadence: advancing
 * `clock` past a registry deadline and polling for the effect exercises the
 * sweep (up silence, seq record idleness, bulk expiry) with no wall-clock wait.
 * The default Date.now + 5 s cadence are what production runs. */
function clockedRegistry(): {
	registry: DaemonTransportRegistry;
	advance: (ms: number) => void;
} {
	let clock = Date.now();
	const registry = new DaemonTransportRegistry({
		now: () => clock,
		sweepIntervalMs: 25,
	});
	return {
		registry,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

describe("daemon transport controlled pairs", () => {
	test("up-end closes the pair's down leg; a late send fails typed; a full redial continues the seq space", async () => {
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

			// A fleet command lands on the down leg.
			const c1 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c1" },
			});
			await waitFor(() => down.seen().find((e) => e.seq === c1.seq), 2000, "c1 delivery");

			// A second command rides the down leg before the daemon ends its upload leg.
			const c2 = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "c2" },
			});
			expect(c2.seq).toBeGreaterThan(c1.seq);
			await waitFor(() => down.seen().find((e) => e.seq === c2.seq), 2000, "c2 delivery");

			// The daemon ends ONLY its upload leg: a renewal. The fleet closes the
			// pair's down leg once it has read the whole up leg, so a send after that
			// fails typed ("unavailable") rather than riding a dead leg.
			expect((await up.end()).status).toBe(200);
			expect(fixture.registry.pairStatus(ws).paired).toBe(false);
			await expect(
				fixture.registry.sendToDaemon(ws, {
					streamId: "control",
					kind: "command",
					payload: { type: "do", id: "late" },
				}),
			).rejects.toMatchObject({ code: "unavailable" });

			// The daemon then loses the DOWN half and redials BOTH halves on
			// the same connectionId. Nothing is replayed: c1 and c2 were already
			// delivered on the dropped leg, and the seq space keeps counting up.
			down.drop();
			const up2 = openUp(fixture, ws, gen, connId, cred);
			const down2 = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down2.seen().find(pairReady), 2000, "pair_ready after redial");
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			expect(down2.seen().some((e) => commandId(e) === "c1" || commandId(e) === "c2")).toBe(false);
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

	test("a long-lived up leg keeps accepting envelopes past CONNECTION_MAX_BYTES of cumulative traffic", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-up-lifetime";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, gen, cred);
		try {
			const up = openUp(fixture, ws, gen, connId, cred);
			const down = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down.seen().find(pairReady), 2000, "pair_ready");
			const delivered: CallbackEnvelope[] = [];
			fixture.registry.attachVirtualStream(ws, "stream/settings", {
				async deliver(e: CallbackEnvelope): Promise<void> {
					delivered.push(e);
				},
			});
			// Settings-model-sized answers (~200 KB each), consumed as they arrive:
			// the cap bounds buffered bytes, never the leg's lifetime total.
			const frames = Math.ceil((CONNECTION_MAX_BYTES * 1.5) / 200_000);
			for (let i = 0; i < frames; i++) {
				up.push("stream/settings", "frame", { type: "call_result", blob: "x".repeat(200_000), i });
				if (i % 8 === 7)
					await waitFor(() => (delivered.length > i ? true : undefined), 4000, `frame ${i}`);
			}
			await waitFor(() => (delivered.length === frames ? true : undefined), 4000, "all frames");
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			const ended = await up.end();
			expect(ended.status).toBe(200);
			expect(ended.body).toMatchObject({ ok: true, received: frames });
		} finally {
			fixture.stop();
		}
	});

	test("a down-half-only redial keeps the up leg live and replays nothing", async () => {
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
			// survives untouched. The daemon redials ONLY the down link on the
			// same connectionId; nothing is replayed.
			down.drop();
			const down2 = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down2.seen().find(pairReady), 2000, "pair_ready after down redial");
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			expect(down2.seen().some((e) => commandId(e) === "c1")).toBe(false);
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

	test("a same-connection down redial replays nothing and continues the seq space", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-redial";
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

			// The down half drops and redials on the same connectionId. Nothing is
			// replayed: `a` was already delivered, and the redial's seqs continue past it.
			first.drop();
			const redial = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => redial.seen().find(pairReady), 2000, "pair_ready on redial");
			expect(redial.seen().some((e) => commandId(e) === "a")).toBe(false);
			const b = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "b" },
			});
			await waitFor(() => redial.seen().find((e) => e.seq === b.seq), 2000, "b delivery");
			expect(b.seq).toBeGreaterThan(a.seq);
			expect(redial.seen().some((e) => commandId(e) === "b")).toBe(true);
			expect((await up.end()).status).toBe(200);
		} finally {
			fixture.stop();
		}
	});

	test("an old-session ack envelope is dropped as an unknown kind, never forwarded, and leaves the pair live", async () => {
		const dropped: string[] = [];
		const fixture = serve(new DaemonTransportRegistry({ onDroppedRecord: (m) => dropped.push(m) }));
		const ws = "ws-legacy-ack";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, gen, cred);
		const tapped: string[] = [];
		const sunk: string[] = [];
		fixture.registry.onDaemonEnvelope(ws, (e) => tapped.push(e.kind));
		fixture.registry.attachVirtualStream(ws, "control", {
			deliver: (e) => {
				sunk.push(e.kind);
			},
		});
		try {
			// A pre-wqd2 session sends `ack` on the up leg as its command receipt. The
			// fleet no longer knows the kind: the record is dropped with a warning, and
			// the upload and pair stay up.
			const up = openUp(fixture, ws, gen, connId, cred);
			const down = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down.seen().find(pairReady), 2000, "pair_ready");
			up.push("control", "ack" as CallbackEnvelope["kind"], { type: "command_ack", id: "legacy" });
			// A following envelope on the same ordered up leg proves the dropped ack did not stall it.
			up.push("control", "command", { type: "cmd", id: "probe" });
			await waitFor(() => (sunk.includes("command") ? true : undefined), 2000, "probe sunk");
			expect(fixture.registry.pairStatus(ws).paired).toBe(true);
			const cmd = await fixture.registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "after-ack" },
			});
			await waitFor(() => down.seen().find((e) => e.seq === cmd.seq), 2000, "command after ack");
			expect((await up.end()).status).toBe(200);
			expect(tapped).toEqual(["command"]);
			expect(dropped).toHaveLength(1);
			expect(sunk).toEqual(["command"]);
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

			// The current generation still works on both legs. The up leg is
			// held open so the down dial joins a real pair; the down fetch is a
			// long-lived SSE stream that only resolves once data flows, so its
			// acceptance is observed via the registry pairing the connection.
			const okConn = randomUUID();
			const okUp = openUp(fixture, ws, 2, okConn, cred2);
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
			expect((await okUp.end()).status).toBe(200);
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
			expect(Buffer.concat(goodResult.chunks ?? []).toString("utf8")).toBe("hello world");

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
			expect(holeResult.chunks).toBeUndefined();

			// An out-of-order FIRST part (1 on a fresh correlation) is
			// rejected the same way; no corrupt prefix is ever buffered.
			const ooo = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const o1 = await postPart(bulkUrl(ooo), H, 1, true, "zzz");
			expect(o1.status).toBe(409);
			const oooResult = await ooo.done;
			expect(oooResult.state).toBe("failed");
			expect(oooResult.chunks).toBeUndefined();

			// A part-less POST is the implicit single-shot transfer.
			const single = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const s0 = await postPart(bulkUrl(single), H, undefined, undefined, "single-shot");
			expect(s0.status).toBe(200);
			const singleResult = await single.done;
			expect(singleResult.state).toBe("received");
			expect(Buffer.concat(singleResult.chunks ?? []).toString("utf8")).toBe("single-shot");

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
			expect(Buffer.concat(foreignResult.chunks ?? []).toString("utf8")).toBe("legit");
		} finally {
			fixture.stop();
		}
	});

	test("a daemon download_bulk_failed control fails its own capture correlation at once; a foreign workspace's id is ignored", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-bulk-failed";
		const wsOther = "ws-bulk-failed-other";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		fixture.registry.enrollWorkspace(wsOther, 1, cred);
		try {
			const mine = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const theirs = fixture.registry.createBulkCorrelation(wsOther, { capture: true });
			let theirsSettled = false;
			void theirs.done.then(() => {
				theirsSettled = true;
			});
			const up = openUp(fixture, ws, 1, randomUUID(), cred);
			up.push("control", "control", {
				type: "download_bulk_failed",
				correlationId: theirs.correlationId,
				error: { code: "unavailable", message: "not yours" },
			});
			up.push("control", "control", {
				type: "download_bulk_failed",
				correlationId: mine.correlationId,
				error: { code: "unavailable", message: "file vanished mid-transfer" },
			});
			const result = await mine.done;
			expect(result.state).toBe("failed");
			expect(result.error).toBe("file vanished mid-transfer");
			expect(result.chunks).toBeUndefined();
			// Envelopes dispatch in order, so the foreign report was handled before this one.
			expect(theirsSettled).toBe(false);
			theirs.cancel("test cleanup");
			expect((await theirs.done).error).toBe("test cleanup");
			expect((await up.end()).status).toBe(200);
		} finally {
			fixture.stop();
		}
	});

	test("cancel settles a capture correlation failed with its reason; a late part is refused and a second cancel changes nothing", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-bulk-cancel";
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, 1, cred);
		try {
			const H = wireHeaders(ws, 1, randomUUID(), cred);
			const urlOf = (corr: { correlationId: string }): string =>
				`${fixture.url}${CALLBACK_BULK_PATH_PREFIX}${corr.correlationId}`;
			const corr = fixture.registry.createBulkCorrelation(ws, { capture: true });
			const first = await fetch(urlOf(corr), {
				method: "POST",
				headers: { ...H, [BULK_PART_HEADER]: "0", [BULK_FINAL_HEADER]: "0" },
				body: "partial",
			});
			expect(first.status).toBe(200);
			corr.cancel("download request aborted");
			const result = await corr.done;
			expect(result.state).toBe("failed");
			expect(result.error).toBe("download request aborted");
			expect(result.chunks).toBeUndefined();
			const late = await fetch(urlOf(corr), {
				method: "POST",
				headers: { ...H, [BULK_PART_HEADER]: "1", [BULK_FINAL_HEADER]: "1" },
				body: "late",
			});
			expect(late.status).toBe(409);
			corr.cancel("second cancel");
			expect((await corr.done).error).toBe("download request aborted");
		} finally {
			fixture.stop();
		}
	});

	test("capture downloads are capped at BULK_CAPTURE_MAX_OPEN open transfers; settling one frees its slot, and plain bulk is uncapped", async () => {
		const registry = new DaemonTransportRegistry();
		const ws = "ws-bulk-cap";
		try {
			const a = registry.createBulkCorrelation(ws, { capture: true });
			const b = registry.createBulkCorrelation(ws, { capture: true });
			expect(() => registry.createBulkCorrelation(ws, { capture: true })).toThrow(
				"too many concurrent downloads (limit 2)",
			);
			const plain = registry.createBulkCorrelation(ws);
			a.cancel("freed");
			expect((await a.done).state).toBe("failed");
			const c = registry.createBulkCorrelation(ws, { capture: true });
			b.cancel("cleanup");
			c.cancel("cleanup");
			plain.cancel("cleanup");
			await Promise.all([b.done, c.done, plain.done]);
		} finally {
			registry.close();
		}
	});

	test("a stalled virtual sink holds only its own promise: each envelope is handed to its sink on arrival, so controls, sibling streams, and a sibling workspace are never queued behind it", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const wsSlow = "ws-slow-sink";
		const wsOther = "ws-other-sink";
		const gen = 1;
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(wsSlow, gen, cred);
		fixture.registry.enrollWorkspace(wsOther, gen, cred);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		try {
			const ws1Conn = randomUUID();
			const up1 = openUp(fixture, wsSlow, gen, ws1Conn, cred);
			const down1 = await openDown(fixture, wsSlow, gen, ws1Conn, cred);
			await waitFor(() => down1.seen().find(pairReady), 2000, "pair_ready wsSlow");

			const slowDelivered: CallbackEnvelope[] = [];
			fixture.registry.attachVirtualStream(wsSlow, "stream/slow", {
				async deliver(e: CallbackEnvelope): Promise<void> {
					slowDelivered.push(e);
					// Stalled until released: the transport must not wait on it.
					await gate;
				},
			});
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

			// 40 x ~190KB frames (~7.6 MiB on the wire, under the 8 MiB up connection cap).
			for (let i = 0; i < 40; i++) {
				up1.push("stream/slow", "frame", { type: "history", blob: "x".repeat(190_000), i });
			}
			up1.push("stream/fast", "frame", { type: "fast", i: 0 });
			for (let i = 0; i < 8; i++) {
				up1.push("control", "command", { type: "cmd", id: `c${i}` });
			}
			await waitFor(
				() =>
					slowDelivered.length === 40 && fastDelivered.length === 1 && ctlDelivered.length === 8
						? true
						: undefined,
				4000,
				"every envelope handed to its sink on arrival",
			);

			// Sibling workspace: its own pair and sink, unaffected by ws1's stall.
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
			expect((await up1.end()).status).toBe(200);
			expect((await up2.end()).status).toBe(200);
		} finally {
			release();
			fixture.stop();
		}
	});

	test("a stalled down reader trips the bounded drop-and-resume teardown; a redial replays nothing and continues the seq space", async () => {
		const fixture = serve(new DaemonTransportRegistry());
		const ws = "ws-down-bound";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		fixture.registry.enrollWorkspace(ws, gen, cred);
		try {
			// A daemon whose downlink cannot keep up with the fleet: the
			// registry must bound the buffered bytes and tear the connection
			// down (drop-and-resume) rather than grow without limit. The up
			// half joins the down so the pair is real; down delivery is the subject.
			const up = openUp(fixture, ws, gen, connId, cred);
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
			await up.end();
			expect(sentSeqs.length).toBeGreaterThan(0);
			// Nothing further is accepted while unpaired.
			await expectUnavailable(
				fixture.registry.sendToDaemon(ws, {
					streamId: "browser/x",
					kind: "frame",
					payload: floodPayload,
				}),
			);

			// Redial on the same connection: nothing from the dropped pair is
			// replayed, and the redialed envelopes continue the seq space past the
			// last sent seq, strictly ascending.
			const up2 = openUp(fixture, ws, gen, connId, cred);
			const redial = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => redial.seen().find(pairReady), 3000, "redial pair_ready");
			const seqs = redial.seen().map((e) => e.seq);
			expect(seqs.length).toBeGreaterThan(0);
			for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
			expect(seqs[0]).toBeGreaterThan(sentSeqs.at(-1)!);
			expect(seqs.some((s) => sentSeqs.includes(s))).toBe(false);
			redial.drop();
			await up2.end();
		} finally {
			fixture.stop();
		}
	});

	test("an up half silent past SILENCE_DEADLINE_MS is killed and the pair reports down", async () => {
		const { registry, advance } = clockedRegistry();
		const fixture = serve(registry);
		const ws = "ws-silence-deadline";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		registry.enrollWorkspace(ws, gen, cred);
		try {
			const up = openUp(fixture, ws, gen, connId, cred);
			const down = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down.seen().find(pairReady), 2000, "pair_ready");
			const paired = registry.pairStatus(ws);
			expect(paired).toMatchObject({
				paired: true,
				connectionId: connId,
				envelopesReceived: 0,
			});
			expect(paired.lastEnvelopeAt).not.toBeNull();
			expect(typeof paired.lastDownSendAt).toBe("number");

			// One daemon envelope makes the liveness counters non-zero; the
			// silence kill must take them back to zero (the connection is
			// gone, not merely quiet).
			up.push("control", "command", { type: "cmd", id: "before-silence" });
			await waitFor(
				() => (registry.pairStatus(ws).envelopesReceived === 1 ? true : undefined),
				2000,
				"up envelope counted",
			);

			// Quiet past the deadline: the sweep kills the upload half AND
			// reports the pair down. A dead daemon must not keep a live-looking
			// down half (the roster would stay "ready" and commands would be
			// accepted into a zombie socket).
			advance(SILENCE_DEADLINE_MS + 1);
			await waitFor(
				() => (registry.pairStatus(ws).paired ? undefined : true),
				2000,
				"paired:false after silence",
			);
			await waitFor(
				() => (registry.pairStatus(ws).envelopesReceived === 0 ? true : undefined),
				2000,
				"killed up half removed",
			);
			const killed = registry.pairStatus(ws);
			expect(killed.connectionId).toBeNull();
			expect(killed.lastEnvelopeAt).toBeNull();
			expect(killed.lastDownSendAt).toBeNull();
			// The down half was closed on the wire, not left hanging.
			await down.ended(2000);
			// The killed upload settles typed, naming the silence deadline.
			const ended = await up.end();
			expect(ended.status).toBe(503);
			expect(ended.body).toMatchObject({ error: "unavailable" });
			expect(bodyString(ended.body, "message")).toContain("silence deadline");
			// No live pair: sends fail `unavailable`, never queued offline.
			await expectUnavailable(
				registry.sendToDaemon(ws, { streamId: "control", kind: "command", payload: {} }),
			);

			// A silent up half whose down half is ALREADY gone (one-sided
			// loss, then quiet) must be killed the same way: the sweep tears
			// nothing down and must not throw on the missing down half.
			const upOnly = openUp(fixture, ws, gen, connId, cred);
			upOnly.push("control", "command", { type: "cmd", id: "up-only" });
			await waitFor(
				() => (registry.pairStatus(ws).envelopesReceived === 1 ? true : undefined),
				2000,
				"up-only envelope counted",
			);
			advance(SILENCE_DEADLINE_MS + 1);
			await waitFor(
				() => (registry.pairStatus(ws).envelopesReceived === 0 ? true : undefined),
				2000,
				"up-only half killed",
			);
			const upOnlyEnded = await upOnly.end();
			expect(upOnlyEnded.status).toBe(503);
			expect(bodyString(upOnlyEnded.body, "message")).toContain("silence deadline");
			expect(registry.pairStatus(ws).paired).toBe(false);

			// Same shape at shutdown: close() kills a live up half that never
			// had a down half without touching a missing one. The half must be
			// REGISTERED before close() (which clears enrollments).
			const orphan = openUp(fixture, ws, gen, randomUUID(), cred);
			orphan.push("control", "command", { type: "cmd", id: "orphan" });
			await waitFor(
				() => (registry.pairStatus(ws).envelopesReceived === 1 ? true : undefined),
				2000,
				"orphan envelope counted",
			);
			registry.close();
			const orphanEnded = await orphan.end();
			expect(orphanEnded.status).toBe(503);
			expect(orphanEnded.body).toMatchObject({ error: "unavailable" });
		} finally {
			fixture.stop();
		}
	});

	test("a down-only dial no up half ever joins is not a pair and is torn down past the deadline (FEDGE-14)", async () => {
		const { registry, advance } = clockedRegistry();
		const fixture = serve(registry);
		const ws = "ws-down-only";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		registry.enrollWorkspace(ws, gen, cred);
		try {
			// Only the down half dials: the leg is half-open. Its fetch only
			// resolves once bytes flow (a down-only dial writes nothing until a
			// heartbeat), so the leg is observed through its body. It must not
			// report a pair, and the sweep must end it once the silence deadline
			// passes. Each poll advances the fake clock past that deadline, so the
			// test holds whether or not the dial has registered yet.
			const dial = fetch(`${fixture.url}${CALLBACK_DOWN_PATH}`, {
				headers: wireHeaders(ws, gen, connId, cred),
			});
			let closed = false;
			dial
				.then((res) => res.text())
				.then(
					() => {
						closed = true;
					},
					() => {
						closed = true;
					},
				);
			expect(registry.pairStatus(ws)).toMatchObject({ paired: false, connectionId: null });
			await waitFor(
				() => {
					advance(SILENCE_DEADLINE_MS + 1);
					return closed ? true : undefined;
				},
				5000,
				"half-open down leg torn down",
			);
			expect(registry.pairStatus(ws).connectionId).toBeNull();
		} finally {
			fixture.stop();
		}
	});

	test("an open bulk correlation idle past BULK_IDLE_MS settles failed as expired, the retryable reason", async () => {
		const { registry, advance } = clockedRegistry();
		const ws = "ws-bulk-ttl";
		const cred = randomBytes(32).toString("hex");
		registry.enrollWorkspace(ws, 1, cred);
		try {
			// No upload ever starts: the sweep owns the open correlation's
			// deadline. `done` never rejects; the settle IS the observable.
			const expired = registry.createBulkCorrelation(ws, { capture: true });
			advance(SWEEP_TTL_MS + 1); // past BULK_IDLE_MS
			const result = await expired.done;
			expect(result.state).toBe("failed");
			expect(result.error).toBe("bulk correlation expired");
			expect(result.bytes).toBe(0);
			expect(result.chunks).toBeUndefined();
		} finally {
			registry.close();
		}
	});

	test("an idle pair kill keeps the seq record for a later redial, which continues the seq space and replays nothing", async () => {
		const { registry, advance } = clockedRegistry();
		const fixture = serve(registry);
		const ws = "ws-seq-idle";
		const gen = 1;
		const connId = randomUUID();
		const cred = randomBytes(32).toString("hex");
		registry.enrollWorkspace(ws, gen, cred);
		try {
			const up = openUp(fixture, ws, gen, connId, cred);
			const down = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down.seen().find(pairReady), 2000, "pair_ready");
			const cmd = await registry.sendToDaemon(ws, {
				streamId: "control",
				kind: "command",
				payload: { type: "do", id: "pre-kill" },
			});
			await waitFor(() => down.seen().find((e) => e.seq === cmd.seq), 2000, "pre-kill delivery");

			// Idle past SEQ_RECORD_IDLE_MS: one sweep pass kills the silent pair. The
			// kill stamps the seq record's last activity, so the record survives the
			// pass and a later redial continues the seq space.
			advance(SWEEP_TTL_MS + 1);
			await waitFor(() => (registry.pairStatus(ws).paired ? undefined : true), 2000, "pair killed");
			await down.ended(2000);
			await up.end();

			// A blind redial: pre-kill envelopes are NOT replayed, and pair_ready
			// follows the last sent seq.
			const up2 = openUp(fixture, ws, gen, connId, cred);
			const down2 = await openDown(fixture, ws, gen, connId, cred);
			await waitFor(() => down2.seen().find(pairReady), 2000, "fresh pair_ready");
			expect(down2.seen().some((e) => commandId(e) === "pre-kill")).toBe(false);
			expect(down2.seen().find(pairReady)?.seq).toBe(cmd.seq + 1);
			down2.drop();
			await up2.end();
		} finally {
			fixture.stop();
		}
	});
});
