import { describe, expect, test } from "bun:test";
import type { PromptCacheStatusDto } from "#lib/wire/protocol";
import { promptCacheExpiresAt, promptCacheIndicator } from "../../usage/prompt-cache";

const base: PromptCacheStatusDto = {
	state: "warm",
	inferred: false,
	tier: "short",
	touchedAt: 10_000,
	ttlMs: 300_000,
	cachedTokens: 40_000,
	nextTokens: 42_000,
};

describe("promptCacheIndicator", () => {
	test("a confirmed warm entry reads warm", () => {
		expect(promptCacheIndicator(base, 20_000)).toEqual({
			tone: "warm",
			label: "warm",
			expired: false,
		});
	});

	test("an inferred warm entry reads likely warm", () => {
		expect(promptCacheIndicator({ ...base, inferred: true }, 20_000)).toEqual({
			tone: "likely",
			label: "likely warm",
			expired: false,
		});
	});

	test("a cold entry reads cold, whatever the clock says", () => {
		const cold: PromptCacheStatusDto = { ...base, state: "cold", reason: { kind: "tools" } };
		expect(promptCacheIndicator(cold, 20_000)).toEqual({
			tone: "cold",
			label: "cold",
			expired: false,
		});
		expect(promptCacheIndicator(cold, 99_000_000).expired).toBe(false);
	});

	test("warm flips to cold at touchedAt + ttlMs, not before", () => {
		const expiresAt = 10_000 + 300_000;
		expect(promptCacheExpiresAt(base)).toBe(expiresAt);
		expect(promptCacheIndicator(base, expiresAt - 1).tone).toBe("warm");
		expect(promptCacheIndicator(base, expiresAt)).toEqual({
			tone: "cold",
			label: "cold",
			expired: true,
		});
		expect(promptCacheIndicator({ ...base, inferred: true }, expiresAt + 1).tone).toBe("cold");
	});

	test("an entry the provider never expires stays warm", () => {
		const { ttlMs: _ttl, ...forever } = base;
		expect(promptCacheExpiresAt(forever)).toBeUndefined();
		expect(promptCacheIndicator(forever, Number.MAX_SAFE_INTEGER).tone).toBe("warm");
	});
});
