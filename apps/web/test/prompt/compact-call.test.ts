/**
 * Manual `/compact` regression: the session answers `compactEx` only after the
 * summarizer finishes (tens of seconds on a real transcript). The transport's
 * default 30 s call timeout rejected the call while the compaction was still
 * running, which surfaced as "The session did not answer in time" and made a
 * retry collide with the run in flight ("Compaction already in progress").
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as transport from "../../store/transport";
import { setState, state } from "../../state";
import { queueManualCompact, runManualCompact } from "../../store/compaction";
import { compactDelivery, dispatchInput, LOCAL_COMMANDS } from "../../prompt/commands";

type Call = { method: string; args: unknown[]; timeoutMs: number | undefined };
let calls: Call[] = [];
let outcome: unknown = { ok: true, data: {} };
let failure: Error | undefined;
let restore: () => void = () => {};

beforeEach(() => {
	calls = [];
	outcome = { ok: true, data: {} };
	failure = undefined;
	const spy = spyOn(transport, "call").mockImplementation(async (method, args = [], timeoutMs) => {
		calls.push({ method, args, timeoutMs });
		if (failure) throw failure;
		return outcome;
	});
	restore = () => spy.mockRestore();
	setState("error", null);
});

afterEach(() => {
	restore();
	setState("streaming", false);
});

/** A compaction run outlives the default 30 s call timeout; every caller must allow for it. */
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

describe("manual compaction call", () => {
	test("/compact waits longer than the default call timeout", () => {
		LOCAL_COMMANDS.compact!("remote focus on api");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe("compactEx");
		expect(calls[0]!.args).toEqual([{ mode: "remote", instructions: "focus on api" }]);
		expect(calls[0]!.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CALL_TIMEOUT_MS);
	});

	test("runManualCompact (Stats dialog Compact now) waits longer than the default call timeout", async () => {
		await runManualCompact({ mode: "soft" });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS).toBeGreaterThan(DEFAULT_CALL_TIMEOUT_MS);
	});

	test("a refused run reports the humanized reason", async () => {
		outcome = { ok: false, error: "ManualCompactionNoOpError: nothing to compact" };
		await runManualCompact({ mode: "soft" });
		expect(state.error).toBe(
			"Nothing to compact yet. The whole session still fits inside the recent messages that compaction keeps.",
		);
	});
});

describe("/compact sent with the follow-up key while a turn streams", () => {
	test("delivery: only the follow-up key during a turn queues; Enter keeps interrupting", () => {
		expect(compactDelivery("followup", true)).toBe("at-yield");
		expect(compactDelivery("enter", true)).toBe("now");
		expect(compactDelivery("followup", false)).toBe("now");
		expect(compactDelivery("enter", false)).toBe("now");
	});

	test("queues through queueCompaction with the same mode and focus text", () => {
		setState("streaming", true);
		dispatchInput("/compact remote focus on api", undefined, "followup");
		expect(calls).toHaveLength(1);
		expect(calls[0]!.method).toBe("queueCompaction");
		expect(calls[0]!.args).toEqual([{ mode: "remote", instructions: "focus on api" }]);
	});

	test("a bare /compact queues with no mode and no focus", () => {
		setState("streaming", true);
		dispatchInput("/compact", undefined, "followup");
		expect(calls.map((c) => c.method)).toEqual(["queueCompaction"]);
		expect(calls[0]!.args).toEqual([{ mode: undefined, instructions: undefined }]);
	});

	test("plain Enter during a turn still runs compactEx now (the terminal UI interrupts too)", () => {
		setState("streaming", true);
		dispatchInput("/compact soft", undefined, "enter");
		expect(calls.map((c) => c.method)).toEqual(["compactEx"]);
	});

	test("idle /compact is unchanged, whichever key sent it", () => {
		dispatchInput("/compact soft", undefined, "followup");
		dispatchInput("/compact soft", undefined, "enter");
		expect(calls.map((c) => c.method)).toEqual(["compactEx", "compactEx"]);
	});

	test("a usage error is reported and nothing queues", () => {
		setState("streaming", true);
		dispatchInput("/compact snapcompact some focus", undefined, "followup");
		expect(calls).toEqual([]);
	});

	test("a refusal from the session surfaces as the session error", async () => {
		failure = new Error("not ready");
		await queueManualCompact({ mode: "soft" });
		expect(state.error).toBe("Not ready");
	});
});
