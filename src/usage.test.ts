import { describe, expect, test } from "bun:test";
import {
	buildUsageRow,
	formatAmount,
	formatDurationMs,
	formatTokensPerSec,
	formatUnitAmount,
	formatUsageRow,
	type UsageLike,
} from "./usage";

describe("buildUsageRow", () => {
	test("null when no usage reported", () => {
		expect(buildUsageRow(undefined)).toBeNull();
	});

	test("core buckets copied through", () => {
		const row = buildUsageRow({ input: 1200, output: 340, cacheRead: 5120, cacheWrite: 0 });
		expect(row).toEqual({
			tokensIn: 1200,
			tokensOut: 340,
			cacheRead: 5120,
			cacheWrite: 0,
		});
	});

	test("ttft included when positive", () => {
		expect(buildUsageRow(usage(), 812, 4200)?.ttftMs).toBe(812);
		expect(buildUsageRow(usage(), 0, 4200)?.ttftMs).toBeUndefined();
		expect(buildUsageRow(usage(), Number.NaN, 4200)?.ttftMs).toBeUndefined();
	});

	test("tokens per second from duration, rounded", () => {
		// 1000 output tokens over 2s → 500 tok/s.
		expect(buildUsageRow({ ...usage(), output: 1000 }, undefined, 2000)?.tokensPerSec).toBe(500);
		// 340 tokens over 4.2s → 80.95… → 81.
		expect(buildUsageRow(usage(), undefined, 4200)?.tokensPerSec).toBe(81);
		// Zero/absent duration → no throughput.
		expect(buildUsageRow(usage(), undefined, 0)?.tokensPerSec).toBeUndefined();
		expect(buildUsageRow(usage())?.tokensPerSec).toBeUndefined();
	});
});

describe("formatUsageRow", () => {
	test("full row renders all segments", () => {
		const row = buildUsageRow({ input: 1200, output: 340, cacheRead: 5120, cacheWrite: 80 }, 812, 4200)!;
		expect(formatUsageRow(row)).toBe("↑1.2k ↓340 · cache 5.1k/80 · ttft 0.8s · 81 tok/s");
	});

	test("cache segment dropped when both buckets are zero", () => {
		const row = buildUsageRow({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 })!;
		expect(formatUsageRow(row)).toBe("↑10 ↓5");
	});

	test("ttft and throughput segments optional", () => {
		const row = buildUsageRow({ input: 100, output: 50, cacheRead: 0, cacheWrite: 0 })!;
		expect(formatUsageRow(row)).toBe("↑100 ↓50");
	});
});

describe("formatDurationMs", () => {
	test("one decimal second", () => {
		expect(formatDurationMs(812)).toBe("0.8s");
		expect(formatDurationMs(3200)).toBe("3.2s");
		expect(formatDurationMs(0)).toBe("0.0s");
	});
});

describe("formatTokensPerSec", () => {
	test("compact token count + suffix", () => {
		expect(formatTokensPerSec(81)).toBe("81 tok/s");
		expect(formatTokensPerSec(1200)).toBe("1.2k tok/s");
	});
});

describe("formatAmount", () => {
	test("locale-grouped integers", () => {
		expect(formatAmount(1250)).toBe("1,250");
		expect(formatAmount(0)).toBe("0");
	});
	test("absent values render as em dash", () => {
		expect(formatAmount(undefined)).toBe("—");
		expect(formatAmount(Number.NaN)).toBe("—");
	});
});

describe("formatUnitAmount", () => {
	test("tokens use the compact formatter", () => {
		expect(formatUnitAmount({ used: 1250, limit: 5000, unit: "tokens" })).toBe("1.3k / 5.0k");
	});

	test("counts are locale-grouped", () => {
		expect(formatUnitAmount({ used: 1250, limit: 5000, unit: "requests" })).toBe("1,250 / 5,000");
	});

	test("percents append %", () => {
		expect(formatUnitAmount({ used: 42, unit: "percent" })).toBe("42%");
	});

	test("missing values render as em dash", () => {
		expect(formatUnitAmount({ unit: "tokens" })).toBe("—");
		expect(formatUnitAmount({ used: 10, unit: "usd" })).toBe("10");
	});
});

function usage(): UsageLike {
	return { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 };
}
