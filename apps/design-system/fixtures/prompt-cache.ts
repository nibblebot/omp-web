/**
 * `getPromptCacheStatus` answers: one per lifecycle the cache indicator distinguishes. Wording is fixture
 * text in the shape the session's SDK helpers produce (the session words it for real); times are built
 * from the clock when the call is answered, so a warm entry is always still inside its lifetime.
 */
import type { PromptCacheDetailRowDto, PromptCacheStatusReply } from "#lib/wire/protocol";

export type PromptCacheFixtureName = "warm" | "likely" | "cold" | "warming" | "none";

const MINUTE = 60_000;

const clock = (at: number): string =>
	new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const rows = (...entries: Array<[string, string, "warning"?]>): PromptCacheDetailRowDto[] =>
	entries.map(([label, value, tone]) => ({ label, value, ...(tone ? { tone } : {}) }));

/** The reply for `name` as of `nowMs`. */
export function promptCacheFixture(
	name: PromptCacheFixtureName,
	nowMs = Date.now(),
): PromptCacheStatusReply {
	switch (name) {
		case "none":
			return { status: null };
		case "warm": {
			const touchedAt = nowMs - MINUTE;
			const expiresAt = touchedAt + 5 * MINUTE;
			return {
				status: {
					state: "warm",
					inferred: false,
					tier: "short",
					touchedAt,
					ttlMs: 5 * MINUTE,
					cachedTokens: 48_200,
					nextTokens: 51_000,
				},
				brief: [`Cached until ${clock(expiresAt)}`, "Next message reads ~48,200 from cache"],
				details: rows(
					["State", "Cached"],
					["Expires", `${clock(expiresAt)} (in 4 min)`],
					["Tier", "5m"],
					["Next message", "reads ~48,200 from cache, sends ~2,800 new"],
				),
			};
		}
		case "likely": {
			const touchedAt = nowMs - 2 * MINUTE;
			const expiresAt = touchedAt + 60 * MINUTE;
			return {
				status: {
					state: "warm",
					inferred: true,
					tier: "long",
					touchedAt,
					ttlMs: 60 * MINUTE,
					cachedTokens: 31_400,
					nextTokens: 31_400,
				},
				brief: [`Likely cached until ${clock(expiresAt)}`, "Next message reads ~31,400 from cache"],
				details: rows(
					["State", "Likely cached"],
					["Expires", `${clock(expiresAt)} (in 58 min)`],
					["Tier", "1h"],
					["Next message", "reads ~31,400 from cache, sends ~0 new"],
				),
			};
		}
		case "warming": {
			const touchedAt = nowMs - 3 * MINUTE;
			const expiresAt = touchedAt + 5 * MINUTE;
			const nextWarmAt = nowMs + MINUTE;
			const stopsAt = nowMs + 27 * MINUTE;
			return {
				status: {
					state: "warm",
					inferred: false,
					tier: "short",
					touchedAt,
					ttlMs: 5 * MINUTE,
					cachedTokens: 48_200,
					nextTokens: 51_000,
					warming: { state: "scheduled", nextWarmAt, stopsAt },
				},
				brief: [`Cached until ${clock(expiresAt)}`, "Next message reads ~48,200 from cache"],
				details: rows(
					["State", "Cached"],
					["Expires", `${clock(expiresAt)} (in 2 min)`],
					["Tier", "5m"],
					["Warming", `next refresh ${clock(nextWarmAt)}, gives up by ${clock(stopsAt)}`],
					["Next message", "reads ~48,200 from cache, sends ~2,800 new"],
				),
			};
		}
		case "cold": {
			const touchedAt = nowMs - 12 * MINUTE;
			return {
				status: {
					state: "cold",
					reason: { kind: "model", from: "claude-sonnet-4-5", to: "claude-opus-4-5" },
					inferred: false,
					tier: "short",
					touchedAt,
					ttlMs: 5 * MINUTE,
					cachedTokens: 48_200,
					nextTokens: 51_000,
				},
				brief: [
					"Not cached \u2014 model changed: claude-sonnet-4-5 \u2192 claude-opus-4-5",
					"Next message re-sends ~51,000",
				],
				details: rows(
					["State", "Not cached", "warning"],
					["Why not cached", "model changed: claude-sonnet-4-5 \u2192 claude-opus-4-5", "warning"],
					["Tier", "5m"],
					["Next message", "re-sends ~51,000 uncached"],
				),
			};
		}
	}
}
