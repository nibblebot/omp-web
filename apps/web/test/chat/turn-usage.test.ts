import { describe, expect, test } from "bun:test";
import type { ChatItem } from "../../state";
import type { UsageLike } from "../../usage/usage";
import {
	buildTurnMeta,
	detectCacheInvalidation,
	promptTimestamp,
	turnElapsedMs,
} from "../../chat/turn-usage";

function usage(over: Partial<UsageLike>): UsageLike {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over } as UsageLike;
}

function user(id: number, timestamp?: number): ChatItem {
	return {
		kind: "user",
		id,
		text: "",
		...(timestamp === undefined ? {} : { timestamp }),
	} as ChatItem;
}

function assistant(id: number, completedAt: number | undefined, u?: UsageLike): ChatItem {
	return {
		kind: "assistant",
		id,
		blocks: [],
		...(completedAt === undefined ? {} : { completedAt }),
		...(u === undefined ? {} : { usage: u }),
	} as ChatItem;
}

describe("detectCacheInvalidation", () => {
	test("flags a warm prefix that is re-created with no reads", () => {
		const prev = usage({ cacheRead: 5000 });
		const cur = usage({ cacheRead: 0, cacheWrite: 4000, input: 100 });
		expect(detectCacheInvalidation(prev, cur)).toBe(4100);
	});

	test("ignores a previous turn that read less than the minimum footprint", () => {
		expect(
			detectCacheInvalidation(usage({ cacheRead: 2047 }), usage({ cacheWrite: 9000 })),
		).toBeUndefined();
	});

	test("ignores implicit caches that report no cacheWrite", () => {
		expect(
			detectCacheInvalidation(usage({ cacheRead: 9000 }), usage({ input: 9000 })),
		).toBeUndefined();
	});

	test("ignores a current turn that still read from cache", () => {
		expect(
			detectCacheInvalidation(
				usage({ cacheRead: 9000 }),
				usage({ cacheRead: 10, cacheWrite: 9000 }),
			),
		).toBeUndefined();
	});

	test("no previous turn means no invalidation", () => {
		expect(detectCacheInvalidation(undefined, usage({ cacheWrite: 9000 }))).toBeUndefined();
	});
});

describe("turnElapsedMs", () => {
	test("returns the rounded elapsed time when both ends are stamped", () => {
		expect(turnElapsedMs(1000, 2499.6)).toBe(1500);
	});

	test("undefined when either end is missing or the span is not positive", () => {
		expect(turnElapsedMs(undefined, 2000)).toBeUndefined();
		expect(turnElapsedMs(1000, undefined)).toBeUndefined();
		expect(turnElapsedMs(2000, 2000)).toBeUndefined();
	});
});

describe("promptTimestamp", () => {
	test("agent-attributed follow-ups do not anchor a turn", () => {
		expect(promptTimestamp({ timestamp: 5, attribution: "agent" })).toBeUndefined();
	});

	test("user prompts anchor with their timestamp", () => {
		expect(promptTimestamp({ timestamp: 5 })).toBe(5);
		expect(promptTimestamp({ timestamp: "x" })).toBeUndefined();
	});
});

describe("buildTurnMeta", () => {
	test("both toggles off yields an empty map", () => {
		const items = [user(1, 0), assistant(2, 500)];
		expect(buildTurnMeta(items, { turnTime: false, cacheMiss: false }).size).toBe(0);
	});

	test("turn time is measured from the latest prompt to each completion", () => {
		const items = [user(1, 1000), assistant(2, 1800), user(3, 2000), assistant(4, 4200)];
		const meta = buildTurnMeta(items, { turnTime: true, cacheMiss: false });
		expect(meta.get(2)).toEqual({ turnMs: 800 });
		expect(meta.get(4)).toEqual({ turnMs: 2200 });
	});

	test("cache miss is attributed to the assistant turn that lost the cache", () => {
		const items = [
			user(1),
			assistant(2, undefined, usage({ cacheRead: 5000, input: 10 })),
			user(3),
			assistant(4, undefined, usage({ cacheWrite: 6000, input: 50 })),
		];
		const meta = buildTurnMeta(items, { turnTime: false, cacheMiss: true });
		expect(meta.get(2)).toBeUndefined();
		expect(meta.get(4)).toEqual({ cacheMissTokens: 6050 });
	});
});
