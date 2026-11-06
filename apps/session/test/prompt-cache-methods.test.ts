/**
 * `getPromptCacheStatus` against a stubbed session: the null answer, a populated one with the SDK's
 * brief and detail rows, JSON safety of the status, and the read-only classification.
 */
import { describe, expect, test } from "bun:test";
import type { PromptCacheStatus } from "@oh-my-pi/pi-tui/status-line/host";
import { promptCacheBrief, promptCacheDetails } from "@oh-my-pi/pi-tui/status-line/prompt-cache";
import { READ_ONLY_METHODS } from "#lib/wire/protocol";
import type { PromptCacheStatusReply } from "#lib/wire/protocol";
import { createPromptCacheMethods } from "../prompt-cache-methods";
import type { SessionEntry } from "../session-entry";

const methods = createPromptCacheMethods();

function entryWith(status: PromptCacheStatus | undefined, seen: number[] = []): SessionEntry {
	return {
		session: {
			getPromptCacheStatus: (nowMs?: number) => {
				if (nowMs !== undefined) seen.push(nowMs);
				return status;
			},
		},
	} as unknown as SessionEntry;
}

const answer = async (entry: SessionEntry) =>
	(await methods.getPromptCacheStatus?.(entry, [])) as PromptCacheStatusReply;

const warm: PromptCacheStatus = {
	state: "warm",
	inferred: false,
	tier: "short",
	touchedAt: Date.now() - 60_000,
	ttlMs: 300_000,
	cachedTokens: 48_000,
	nextTokens: 52_000,
	warming: {
		state: "scheduled",
		nextWarmAt: Date.now() + 120_000,
		stopsAt: Date.now() + 3_600_000,
	},
};

describe("getPromptCacheStatus", () => {
	test("is read-only", () => {
		expect(READ_ONLY_METHODS.getPromptCacheStatus).toBe(true);
	});

	test("answers { status: null } without a status", async () => {
		const reply = await answer(entryWith(undefined));
		expect(reply).toEqual({ status: null });
		expect(Object.keys(reply)).toEqual(["status"]);
	});

	test("answers the status with the SDK's brief and detail rows", async () => {
		const seen: number[] = [];
		const before = Date.now();
		const reply = await answer(entryWith(warm, seen));
		expect(seen).toHaveLength(1);
		expect(seen[0]).toBeGreaterThanOrEqual(before);
		expect(reply.status).toEqual(warm);
		const at = seen[0] as number;
		expect(reply.brief).toEqual([...promptCacheBrief(warm, at)]);
		expect(reply.details).toEqual(promptCacheDetails(warm, at));
		expect(reply.brief?.[0]).toStartWith("Cached until");
		expect(reply.details?.map((row) => row.label)).toEqual([
			"State",
			"Expires",
			"Tier",
			"Warming",
			"Next message",
		]);
	});

	test("a cold status carries its reason and warning-toned rows", async () => {
		const cold: PromptCacheStatus = {
			state: "cold",
			reason: { kind: "model", from: "opus", to: "sonnet" },
			inferred: false,
			tier: "short",
			touchedAt: Date.now() - 900_000,
			ttlMs: 300_000,
			cachedTokens: 48_000,
			nextTokens: 52_000,
		};
		const reply = await answer(entryWith(cold));
		expect(reply.status?.reason).toEqual({ kind: "model", from: "opus", to: "sonnet" });
		expect(reply.brief?.[0]).toContain("Not cached");
		expect(reply.details?.filter((row) => row.tone === "warning").map((row) => row.label)).toEqual([
			"State",
			"Why not cached",
		]);
	});

	test("omits what the SDK leaves undefined, so the answer survives JSON", async () => {
		const inferred: PromptCacheStatus = {
			state: "warm",
			inferred: true,
			tier: "long",
			touchedAt: 1_000,
			cachedTokens: 10,
			nextTokens: 20,
			ttlMs: undefined,
			reason: undefined,
			warming: undefined,
		};
		const reply = await answer(entryWith(inferred));
		expect(Object.keys(reply.status ?? {}).sort()).toEqual([
			"cachedTokens",
			"inferred",
			"nextTokens",
			"state",
			"tier",
			"touchedAt",
		]);
		expect(JSON.parse(JSON.stringify(reply))).toEqual(reply);
	});
});
