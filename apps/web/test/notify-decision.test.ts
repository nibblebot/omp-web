import { describe, expect, test } from "bun:test";
import { NOTIFY_SETTING_PATH, notifyKindEnabled, outcomeNotice } from "../store/notify";

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

describe("outcomeNotice (kind and body by turn outcome)", () => {
	test("a normal stop or a missing stopReason is a Complete completion", () => {
		expect(outcomeNotice({ stopReason: "stop" })).toEqual({ kind: "completion", body: "Complete" });
		expect(outcomeNotice({})).toEqual({ kind: "completion", body: "Complete" });
		expect(outcomeNotice({ stopReason: "toolUse" })).toEqual({
			kind: "completion",
			body: "Complete",
		});
	});

	test("an aborted turn is an Aborted completion (no abort setting exists)", () => {
		expect(outcomeNotice({ stopReason: "aborted", errorMessage: "ignored" })).toEqual({
			kind: "completion",
			body: "Aborted",
		});
	});

	test("an errored turn is an error notice carrying its message when non-empty", () => {
		expect(outcomeNotice({ stopReason: "error", errorMessage: "boom" })).toEqual({
			kind: "error",
			body: "Stopped with error: boom",
		});
		expect(outcomeNotice({ stopReason: "error" })).toEqual({
			kind: "error",
			body: "Stopped with error",
		});
		expect(outcomeNotice({ stopReason: "error", errorMessage: "  " })).toEqual({
			kind: "error",
			body: "Stopped with error",
		});
	});

	test("the error message is capped at 80 characters", () => {
		const prefix = "Stopped with error: ";
		expect(outcomeNotice({ stopReason: "error", errorMessage: "x".repeat(80) }).body).toBe(
			prefix + "x".repeat(80),
		);
		expect(outcomeNotice({ stopReason: "error", errorMessage: "x".repeat(81) }).body).toBe(
			prefix + "x".repeat(80),
		);
	});
});
