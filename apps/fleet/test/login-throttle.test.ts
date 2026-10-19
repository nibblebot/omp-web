/**
 * Unit tests for the per-client login backoff (FEDGE-11): free failures,
 * exponential lock, the five-minute cap, success reset, quiet-period
 * forgetting, per-client isolation, and the bounded table. The clock is
 * injected so every window is exact.
 */
import { describe, expect, test } from "bun:test";
import { LoginThrottle } from "../login-throttle";

const MINUTE = 60_000;

function throttleAt() {
	const clock = { t: 0 };
	const throttle = new LoginThrottle({ now: () => clock.t });
	return { throttle, clock };
}

describe("LoginThrottle", () => {
	test("the first five failures are free", () => {
		const { throttle } = throttleAt();
		for (let i = 0; i < 5; i++) {
			throttle.recordFailure("203.0.113.9");
			expect(throttle.retryAfterMs("203.0.113.9")).toBe(0);
		}
	});

	test("the sixth failure locks the client for one second", () => {
		const { throttle, clock } = throttleAt();
		for (let i = 0; i < 6; i++) throttle.recordFailure("203.0.113.9");
		expect(throttle.retryAfterMs("203.0.113.9")).toBe(1000);
		clock.t = 999;
		expect(throttle.retryAfterMs("203.0.113.9")).toBe(1);
		clock.t = 1000;
		expect(throttle.retryAfterMs("203.0.113.9")).toBe(0);
	});

	test("each further failure doubles the lock, capped at five minutes", () => {
		const { throttle } = throttleAt();
		const client = "203.0.113.9";
		const locks: number[] = [];
		for (let i = 0; i < 16; i++) {
			throttle.recordFailure(client);
			locks.push(throttle.retryAfterMs(client));
		}
		expect(locks.slice(5, 10)).toEqual([1000, 2000, 4000, 8000, 16000]);
		expect(locks[15]).toBe(5 * MINUTE);
	});

	test("a success clears the record", () => {
		const { throttle } = throttleAt();
		const client = "203.0.113.9";
		for (let i = 0; i < 6; i++) throttle.recordFailure(client);
		expect(throttle.retryAfterMs(client)).toBe(1000);
		throttle.recordSuccess(client);
		expect(throttle.retryAfterMs(client)).toBe(0);
		throttle.recordFailure(client);
		expect(throttle.retryAfterMs(client)).toBe(0);
	});

	test("fifteen quiet minutes forget the failure count", () => {
		const { throttle, clock } = throttleAt();
		const client = "203.0.113.9";
		for (let i = 0; i < 6; i++) throttle.recordFailure(client);
		clock.t = 15 * MINUTE + 1;
		expect(throttle.retryAfterMs(client)).toBe(0);
		for (let i = 0; i < 5; i++) throttle.recordFailure(client);
		expect(throttle.retryAfterMs(client)).toBe(0);
		throttle.recordFailure(client);
		expect(throttle.retryAfterMs(client)).toBe(1000);
	});

	test("clients are throttled independently", () => {
		const { throttle } = throttleAt();
		for (let i = 0; i < 6; i++) throttle.recordFailure("198.51.100.7");
		expect(throttle.retryAfterMs("198.51.100.7")).toBe(1000);
		expect(throttle.retryAfterMs("203.0.113.9")).toBe(0);
	});

	test("the table is bounded: the least recently failing client is dropped first", () => {
		const { throttle } = throttleAt();
		for (let i = 0; i < 6; i++) throttle.recordFailure("oldest");
		for (let i = 0; i < 4096; i++) {
			throttle.recordFailure(`10.0.${Math.floor(i / 256)}.${i % 256}`);
		}
		expect(throttle.retryAfterMs("oldest")).toBe(0);
	});
});
