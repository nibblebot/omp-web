import { describe, expect, test } from "bun:test";
import type { UsageLimit, UsageWindow } from "@oh-my-pi/pi-ai";
import {
	buildUsageRow,
	formatAmount,
	formatDurationMs,
	formatTurnStamp,
	formatTokensPerSec,
	formatUnitAmount,
	formatUsageRow,
	formatTimeRemaining,
	resolveElapsedFraction,
	resolveUsedPercent,
	usageBrand,
	type UsageLike,
} from "../../usage/usage";

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
		const row = buildUsageRow(
			{ input: 1200, output: 340, cacheRead: 5120, cacheWrite: 80 },
			812,
			4200,
		)!;
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
	test("absent values render as a dash", () => {
		expect(formatAmount(undefined)).toBe("-");
		expect(formatAmount(Number.NaN)).toBe("-");
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

	test("missing values render as a dash", () => {
		expect(formatUnitAmount({ unit: "tokens" })).toBe("-");
		expect(formatUnitAmount({ limit: 100, unit: "usd" })).toBe("- / $100.00");
	});

	test("usd reads as dollars with two decimals, capped and uncapped", () => {
		expect(formatUnitAmount({ used: 12.3456, limit: 100, unit: "usd" })).toBe("$12.35 / $100.00");
		expect(formatUnitAmount({ used: 10, unit: "usd" })).toBe("$10.00");
		expect(formatUnitAmount({ used: 1234.5, limit: 5000, unit: "usd" })).toBe(
			"$1,234.50 / $5,000.00",
		);
	});

	test("usd rounds sub-cent spend to the cent", () => {
		expect(formatUnitAmount({ used: 0.004, unit: "usd" })).toBe("$0.00");
		expect(formatUnitAmount({ used: 0.0051, limit: 0.5, unit: "usd" })).toBe("$0.01 / $0.50");
	});
});

describe("resolveUsedPercent", () => {
	const budget = (amount: UsageLimit["amount"]): UsageLimit => ({
		id: "litellm:key:budget",
		label: "Key budget",
		scope: { provider: "litellm", shared: true },
		amount,
	});

	test("an uncapped budget has no bar", () => {
		expect(resolveUsedPercent(budget({ used: 3.2, unit: "usd" }))).toBeUndefined();
	});

	test("a capped budget fills to its share, clamped to 0..100", () => {
		expect(resolveUsedPercent(budget({ used: 25, limit: 100, unit: "usd" }))).toBe(25);
		expect(resolveUsedPercent(budget({ used: 0, limit: 100, unit: "usd" }))).toBe(0);
		expect(resolveUsedPercent(budget({ used: 140, limit: 100, unit: "usd" }))).toBe(100);
		// A zero cap blocks every request; the adapter reports it as fully used.
		expect(resolveUsedPercent(budget({ used: 0, limit: 0, usedFraction: 1, unit: "usd" }))).toBe(
			100,
		);
	});
});

describe("formatTimeRemaining", () => {
	const now = Date.parse("2026-10-09T10:00:00Z");
	const MIN = 60_000;

	test("floors to the two largest units", () => {
		expect(formatTimeRemaining(now + 3 * 1440 * MIN + 4 * 60 * MIN + 59 * MIN, now)).toBe("3d 4h");
		expect(formatTimeRemaining(now + 95 * MIN + 59_000, now)).toBe("1h 35m");
		expect(formatTimeRemaining(now + 60 * MIN, now)).toBe("1h 0m");
		expect(formatTimeRemaining(now + 1440 * MIN, now)).toBe("1d 0h");
		expect(formatTimeRemaining(now + 59 * MIN + 59_000, now)).toBe("59m");
	});

	test("under a minute and past resets", () => {
		expect(formatTimeRemaining(now + 59_999, now)).toBe("<1m");
		expect(formatTimeRemaining(now, now)).toBe("now");
		expect(formatTimeRemaining(now - 5 * MIN, now)).toBe("now");
	});
});

describe("usageBrand", () => {
	test("maps provider families to logos, others to none", () => {
		expect(usageBrand("anthropic")).toBe("anthropic");
		expect(usageBrand("openai-codex")).toBe("openai");
		expect(usageBrand("openai")).toBe("openai");
		expect(usageBrand("opencode-go")).toBe("opencode");
		expect(usageBrand("openrouter")).toBeUndefined();
		expect(usageBrand("github-copilot")).toBeUndefined();
	});
});

function usage(): UsageLike {
	return { input: 1200, output: 340, cacheRead: 0, cacheWrite: 0 };
}

describe("resolveElapsedFraction", () => {
	const now = Date.parse("2026-10-09T10:00:00Z");
	const HOUR = 3_600_000;
	const limit = (window: Partial<UsageWindow>): UsageLimit => ({
		id: "5h",
		label: "5 Hour",
		scope: { provider: "anthropic" },
		window: { id: "5h", label: "5 Hour", ...window },
		amount: { unit: "percent", usedFraction: 0.5 },
	});

	test("elapsed share of the window, clamped to 0..1", () => {
		expect(
			resolveElapsedFraction(limit({ durationMs: 5 * HOUR, resetsAt: now + 4 * HOUR }), now),
		).toBeCloseTo(0.2);
		expect(
			resolveElapsedFraction(limit({ durationMs: 5 * HOUR, resetsAt: now + 5 * HOUR }), now),
		).toBe(0);
		// A stale report (reset already passed) and a reset further out than the window clamp.
		expect(resolveElapsedFraction(limit({ durationMs: 5 * HOUR, resetsAt: now - HOUR }), now)).toBe(
			1,
		);
		expect(
			resolveElapsedFraction(limit({ durationMs: 5 * HOUR, resetsAt: now + 6 * HOUR }), now),
		).toBe(0);
	});

	test("no marker without a full window, or when resetsAt is a regen tick", () => {
		expect(resolveElapsedFraction(limit({ resetsAt: now + HOUR }), now)).toBeUndefined();
		expect(resolveElapsedFraction(limit({ durationMs: 5 * HOUR }), now)).toBeUndefined();
		expect(
			resolveElapsedFraction(
				limit({ durationMs: 5 * HOUR, resetsAt: now + HOUR, resetLabel: "tick" }),
				now,
			),
		).toBeUndefined();
		expect(
			resolveElapsedFraction(
				limit({ durationMs: 5 * HOUR, resetsAt: now + HOUR, resetLabel: "resets" }),
				now,
			),
		).toBeCloseTo(0.8);
	});
});

describe("formatTurnStamp", () => {
	const fields = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } as const;
	const now = new Date(2026, 9, 28, 12, 0).getTime();

	test("the same year omits it", () => {
		const at = new Date(2026, 9, 20, 14, 32).getTime();
		expect(formatTurnStamp(at, now)).toBe(new Date(at).toLocaleString(undefined, fields));
	});

	test("another year adds it", () => {
		const at = new Date(2025, 11, 31, 23, 59).getTime();
		expect(formatTurnStamp(at, now)).toBe(
			new Date(at).toLocaleString(undefined, { year: "numeric", ...fields }),
		);
		expect(formatTurnStamp(at, now)).toContain("2025");
	});
});
