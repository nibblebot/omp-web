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
import { runManualCompact } from "../../store/compaction";
import { LOCAL_COMMANDS } from "../../prompt/commands";

type Call = { method: string; args: unknown[]; timeoutMs: number | undefined };
let calls: Call[] = [];
let outcome: unknown = { ok: true, data: {} };
let restore: () => void = () => {};

beforeEach(() => {
	calls = [];
	outcome = { ok: true, data: {} };
	const spy = spyOn(transport, "call").mockImplementation(async (method, args = [], timeoutMs) => {
		calls.push({ method, args, timeoutMs });
		return outcome;
	});
	restore = () => spy.mockRestore();
	setState("error", null);
});

afterEach(() => restore());

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
