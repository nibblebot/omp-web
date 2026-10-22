import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { Mock } from "bun:test";
import { wsAdapter } from "../adapters/ws";
import { ProfileClient } from "../client";
import { FakeFleet, type Frame } from "./fake-fleet";

/**
 * `ProfileClient.prompt()` replays a command the edge answered `call_result ok:false
 * "not attached"` after the next `attached` frame, re-sending the SAME id (the web store's
 * parked-call replay, apps/web/store/transport.ts). The real run only hits this in the few ms
 * between two callback pairs, so it is driven here against a minimal fake fleet (./fake-fleet.ts):
 * `GET /ws` frames (real lib/wire/browser-socket builders) and an ack per command.
 *
 * No test waits on a guessed duration: the replay path logs to stderr right before it starts
 * waiting for the re-attach, so the spy's call is the "client is parked" signal, and "the turn
 * has not ended yet" is asserted after a `ping` call round trip (the fleet answers it), which
 * is issued after the re-send's ack was written and so completes after the client handled it.
 */

const notAttached = (id: string): Frame => ({
	type: "call_result",
	id,
	ok: false,
	error: "not attached",
});

const textDelta = (delta: string): Frame => ({
	type: "event",
	event: {
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	},
});

let fleet: FakeFleet;
let client: ProfileClient;
let errorSpy: Mock<(...data: unknown[]) => void>;
/** Resolves when the client logged that it is parked waiting for the re-attach. */
let parked: PromiseWithResolvers<void>;

beforeEach(async () => {
	parked = Promise.withResolvers<void>();
	// The replay path logs to stderr by design; keep the output clean and use it as the signal.
	errorSpy = spyOn(console, "error").mockImplementation(() => parked.resolve());
	fleet = new FakeFleet();
	client = await ProfileClient.connect(wsAdapter, fleet.baseUrl, { resilient: false });
});

/** Barrier, then assert `turn` has not settled. */
async function expectTurnPending(turn: Promise<unknown>): Promise<void> {
	await client.call("ping", [], 5_000);
	expect(await Promise.race([turn, Promise.resolve("pending")])).toBe("pending");
}

afterEach(async () => {
	await client.close();
	await fleet.stop();
	errorSpy.mockRestore();
});

test("not-attached prompt is re-sent once with the same id after the re-attach; the re-prime idle state does not end the turn", async () => {
	const turn = client.prompt("hello", 10_000, 10_000);
	turn.catch(() => undefined);

	const first = await fleet.command(1);
	expect(first).toMatchObject({ type: "call", method: "prompt", args: ["hello"] });
	fleet.push(notAttached(first.id));
	await parked.promise;

	// The re-attach primes an idle session: the turn has not started, so this idle state
	// (it follows an `attached` frame) must not end it.
	fleet.prime(false);
	const second = await fleet.command(2);
	expect(second).toEqual(first);
	// Re-sent only after the re-attach.
	expect(fleet.primesAtPost).toEqual([0, 1]);
	await expectTurnPending(turn);

	// The turn proper: accepted, streams a delta, then a pair replacement re-primes the stream
	// mid-turn and the idle state after that re-prime is the turn's end.
	fleet.push({ type: "call_result", id: first.id, ok: true }, textDelta("hi"));
	fleet.prime(false);

	const timings = await turn;
	expect(timings.firstDeltaMs).toBeDefined();
	expect(timings.turnMs).toBeGreaterThan(0);
	expect(client.pendingWaiters).toBe(0);

	// Exactly one re-send: never a third copy, and the same id both times.
	expect(fleet.commands.filter((c) => c.method === "prompt").map((c) => c.id)).toEqual([
		first.id,
		first.id,
	]);
	expect(errorSpy).toHaveBeenCalledTimes(1);
	expect(String(errorSpy.mock.calls[0]?.[0])).toContain("not attached");
});

test("a replayed prompt also completes on agent_end", async () => {
	const turn = client.prompt("hello", 10_000, 10_000);
	turn.catch(() => undefined);

	const first = await fleet.command(1);
	fleet.push(notAttached(first.id));
	await parked.promise;
	fleet.prime(false);
	const second = await fleet.command(2);
	expect(second.id).toBe(first.id);

	fleet.push({ type: "call_result", id: first.id, ok: true }, textDelta("hi"), {
		type: "event",
		event: { type: "agent_end" },
	});
	const timings = await turn;
	expect(timings.firstDeltaMs).toBeDefined();
	expect(client.pendingWaiters).toBe(0);
	expect(fleet.commands.filter((c) => c.method === "prompt")).toHaveLength(2);
});

test("a prompt rejected for another reason is not replayed", async () => {
	const turn = client.prompt("hello", 10_000, 10_000);
	const failure = turn.then(
		() => undefined,
		(err: unknown) => err,
	);

	const first = await fleet.command(1);
	fleet.push({ type: "call_result", id: first.id, ok: false, error: "session busy" });
	const err = await failure;
	expect(err).toBeInstanceOf(Error);
	expect((err as Error).message).toBe("prompt rejected: session busy");
	expect(fleet.commands).toHaveLength(1);
	expect(errorSpy).not.toHaveBeenCalled();
});

test("no attached frame within the cap fails the prompt with a clear error and sends nothing more", async () => {
	// The cap is the client's own timer (a real wall-clock wait by construction); keep it short.
	const turn = client.prompt("hello", 10_000, 20);
	const failure = turn.then(
		() => undefined,
		(err: unknown) => err,
	);

	const first = await fleet.command(1);
	fleet.push(notAttached(first.id));

	const err = await failure;
	expect(err).toBeInstanceOf(Error);
	expect((err as Error).message).toBe(
		"timed out waiting for re-attach after a not-attached prompt (20ms)",
	);
	expect(fleet.commands).toHaveLength(1);
	// The turn-end waiter (and its 10 s timer) must not outlive the failed prompt.
	expect(client.pendingWaiters).toBe(0);
});

test("a turn that ends with the call_result lost leaves no waiter behind", async () => {
	const turn = client.prompt("hello", 10_000, 10_000);
	const first = await fleet.command(1);
	expect(first.method).toBe("prompt");
	fleet.push({ type: "event", event: { type: "agent_end" } });
	await turn;
	expect(client.pendingWaiters).toBe(0);
});
