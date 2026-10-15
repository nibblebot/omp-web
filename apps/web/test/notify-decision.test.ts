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
	const assistant = (stopReason: string) => ({ role: "assistant", stopReason });

	test("a turn ending in a normal stop counts as complete", () => {
		expect(turnCompleted([{ role: "user" }, assistant("stop")])).toBe(true);
	});

	test("an errored or aborted last assistant message does not count", () => {
		expect(turnCompleted([assistant("error")])).toBe(false);
		expect(turnCompleted([{ role: "user" }, assistant("aborted")])).toBe(false);
	});

	test("only the last assistant message decides", () => {
		expect(turnCompleted([assistant("error"), { role: "user" }, assistant("stop")])).toBe(true);
	});

	test("missing messages or no assistant message counts as complete", () => {
		expect(turnCompleted(undefined)).toBe(true);
		expect(turnCompleted([{ role: "user" }])).toBe(true);
	});
});

describe("turnFailure (error notification mirrors sendErrorNotification)", () => {
	const assistant = (stopReason: string, errorMessage?: string) => ({
		role: "assistant",
		stopReason,
		errorMessage,
	});

	test("a settled turn whose last assistant stopped in error returns its errorMessage", () => {
		expect(turnFailure([{ role: "user" }, assistant("error", "boom")])).toBe("boom");
	});

	test("a missing errorMessage yields an empty body rather than silence", () => {
		expect(turnFailure([assistant("error")])).toBe("");
	});

	test("normal stop, aborted, or no assistant message stays silent", () => {
		expect(turnFailure([assistant("stop")])).toBeUndefined();
		expect(turnFailure([assistant("aborted", "x")])).toBeUndefined();
		expect(turnFailure([{ role: "user" }])).toBeUndefined();
		expect(turnFailure(undefined)).toBeUndefined();
	});

	test("only the last assistant message decides", () => {
		expect(
			turnFailure([assistant("error", "boom"), { role: "user" }, assistant("stop")]),
		).toBeUndefined();
	});

	test("non-terminal agent_end or a pending retry stays silent", () => {
		const messages = [assistant("error", "boom")];
		expect(turnFailure(messages, { terminal: false })).toBeUndefined();
		expect(turnFailure(messages, { retryPending: true })).toBeUndefined();
		expect(turnFailure(messages)).toBe("boom");
	});
});
