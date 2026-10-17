import { describe, expect, test } from "bun:test";
import { compactionItemOf, humanizeCompactionError } from "../../store/compaction-view";

describe("humanizeCompactionError", () => {
	test("replaces the SDK no-op class prefix with a plain sentence (CMD-13)", () => {
		const text = humanizeCompactionError(
			new Error("ManualCompactionNoOpError: Nothing to compact (session too small)"),
		);
		expect(text).not.toContain("Error");
		expect(text).toStartWith("Nothing to compact yet.");
	});

	test("collapses doubled Error prefixes from the RPC layer", () => {
		expect(humanizeCompactionError("Error: Error: Nothing to hand off (already compacted)")).toBe(
			"Nothing to hand off yet. The session is too short to summarize.",
		);
	});

	test("explains an empty session", () => {
		expect(humanizeCompactionError("Nothing to compact: no messages yet")).toBe(
			"There is nothing to compact yet. Send a message first.",
		);
	});

	test("maps the common refusals and keeps unknown text, capitalized", () => {
		expect(humanizeCompactionError("No model selected")).toStartWith("No model is selected.");
		expect(humanizeCompactionError("operation aborted")).toBe("Compaction was cancelled.");
		expect(humanizeCompactionError('call "compactionSnapshot" timed out')).toBe(
			"The session did not answer in time. Try again in a moment.",
		);
		expect(humanizeCompactionError("disk on fire")).toBe("Disk on fire");
		expect(humanizeCompactionError("")).toBe("Compaction failed. Try again.");
	});
});

describe("compactionItemOf", () => {
	test("maps a compaction summary message to a card with before and after tokens", () => {
		const item = compactionItemOf({
			role: "compactionSummary",
			summary: "Kept the plan.",
			tokensBefore: 148_000,
			tokensAfter: 22_000,
			method: "soft",
			timestamp: 1_700_000_000,
		});
		expect(item).toMatchObject({
			kind: "compaction",
			action: "compact",
			summary: "Kept the plan.",
			tokensBefore: 148_000,
			tokensAfter: 22_000,
			method: "soft",
			skipped: false,
			aborted: false,
		});
	});

	test("marks handoff messages and tolerates missing numbers", () => {
		const item = compactionItemOf({
			role: "compactionSummary",
			method: "handoff",
			tokensBefore: "x",
		});
		expect(item?.action).toBe("handoff");
		expect(item?.tokensBefore).toBeUndefined();
		expect(item?.tokensAfter).toBeUndefined();
		expect(item?.summary).toBeUndefined();
	});

	test("returns null for other messages", () => {
		expect(compactionItemOf({ role: "user", content: "hi" })).toBeNull();
		expect(compactionItemOf(null)).toBeNull();
	});
});
