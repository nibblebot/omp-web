/**
 * Unit tests for the stored-session load-error state (src/tx/util/stored-error.ts):
 * a missing session names itself and offers no Retry; other failures keep Retry
 * and never surface a raw class name.
 */
import { describe, expect, test } from "bun:test";
import { ApiError } from "../../../store/fleet-api";
import { storedLoadError } from "../../../tx/util/stored-error";

describe("storedLoadError", () => {
	test("404 / unavailable names the session and is not retryable", () => {
		const info = storedLoadError(
			new ApiError("session not found in fleet store", 404, "unavailable"),
			"sess1",
		);
		expect(info).toEqual({ title: "Session sess1 is not in fleet storage.", retryable: false });
	});

	test("bare 404 without a typed code is also not retryable", () => {
		const info = storedLoadError(new ApiError("HTTP 404", 404), "sess1");
		expect(info.retryable).toBe(false);
		expect(info.title).toContain("sess1");
	});

	test("other ApiErrors keep Retry and show the server message, not the class name", () => {
		const info = storedLoadError(new ApiError("store offline", 503, "unavailable"), "sess1");
		expect(info.retryable).toBe(true);
		expect(info.title).toBe("Failed to load this stored session: store offline");
		expect(info.title).not.toContain("ApiError");
	});

	test("non-Error throwables fall back to String(err) and stay retryable", () => {
		expect(storedLoadError("boom", "sess1")).toEqual({
			title: "Failed to load this stored session: boom",
			retryable: true,
		});
	});
});
