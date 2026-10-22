import { describe, expect, test } from "bun:test";
import {
	NOTIFY_SETTING_PATH,
	notifyKindEnabled,
	turnCompleted,
	turnFailure,
} from "../store/notify";

describe("notifyKindEnabled (SDK setting decides per event kind)", () => {
	test("explicit on/off values are honoured for every kind", () => {
		for (const kind of ["completion", "error", "ask"] as const) {
			expect(notifyKindEnabled(kind, "on")).toBe(true);
			expect(notifyKindEnabled(kind, "off")).toBe(false);
		}
	});

	test("unloaded or unrecognised values fall back to the SDK defaults", () => {
		expect(notifyKindEnabled("completion", undefined)).toBe(true);
		expect(notifyKindEnabled("ask", undefined)).toBe(true);
		expect(notifyKindEnabled("error", undefined)).toBe(false);
		expect(notifyKindEnabled("error", "bogus")).toBe(false);
		expect(notifyKindEnabled("completion", true)).toBe(true);
	});

	test("settings paths match the SDK rows", () => {
		expect(NOTIFY_SETTING_PATH).toEqual({
			completion: "completion.notify",
			error: "error.notify",
			ask: "ask.notify",
		});
	});
});

describe("turnCompleted (completion skips errored or aborted turns)", () => {
	test("a turn ending in a normal stop counts as complete", () => {
		expect(turnCompleted({ stopReason: "stop" })).toBe(true);
	});

	test("an errored or aborted last assistant message does not count", () => {
		expect(turnCompleted({ stopReason: "error" })).toBe(false);
		expect(turnCompleted({ stopReason: "aborted" })).toBe(false);
	});

	test("a turn with no assistant message counts as complete", () => {
		expect(turnCompleted(undefined)).toBe(true);
	});
});

describe("turnFailure (error notification mirrors sendErrorNotification)", () => {
	test("a settled turn whose last assistant stopped in error returns its errorMessage", () => {
		expect(turnFailure({ stopReason: "error", errorMessage: "boom" })).toBe("boom");
	});

	test("a missing errorMessage yields an empty body rather than silence", () => {
		expect(turnFailure({ stopReason: "error" })).toBe("");
	});

	test("normal stop, aborted, or no assistant message stays silent", () => {
		expect(turnFailure({ stopReason: "stop" })).toBeUndefined();
		expect(turnFailure({ stopReason: "aborted", errorMessage: "x" })).toBeUndefined();
		expect(turnFailure(undefined)).toBeUndefined();
	});

	test("non-terminal agent_end or a pending retry stays silent", () => {
		const last = { stopReason: "error", errorMessage: "boom" } as const;
		expect(turnFailure(last, { terminal: false })).toBeUndefined();
		expect(turnFailure(last, { retryPending: true })).toBeUndefined();
		expect(turnFailure(last)).toBe("boom");
	});
});
