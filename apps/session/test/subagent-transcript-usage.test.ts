import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDirs, tempDir } from "#lib/testkit/temp-dir.testkit";
import { transcriptUsage } from "../subagent-transcript-usage";

afterAll(cleanupTempDirs);

function assistant(usage: Record<string, unknown>): string {
	return JSON.stringify({ type: "message", message: { role: "assistant", usage } });
}

function transcript(lines: string[]): string {
	const dir = tempDir("omp-transcript-usage-");
	const file = join(dir, "child.jsonl");
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

describe("transcriptUsage", () => {
	test("sums every assistant turn's tokens, requests, and cost; ignores other roles", async () => {
		const file = transcript([
			JSON.stringify({ type: "message", message: { role: "user", content: "count" } }),
			assistant({ totalTokens: 120, input: 100, output: 20, cost: { total: 0.01 } }),
			JSON.stringify({ type: "message", message: { role: "toolResult", content: [] } }),
			assistant({ totalTokens: 80, input: 60, output: 20, cost: { total: 0.005 } }),
		]);
		expect(await transcriptUsage(file)).toEqual({ tokens: 200, requests: 2, cost: 0.015 });
	});

	test("per turn tokens are input + output + cacheWrite; cacheRead is excluded", async () => {
		const file = transcript([
			assistant({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, cost: { total: 0 } }),
		]);
		expect(await transcriptUsage(file)).toEqual({ tokens: 17, requests: 1, cost: 0 });
	});

	test("totalTokens is the fallback only when the component sum is zero", async () => {
		const file = transcript([assistant({ totalTokens: 40, cost: { total: 0.002 } })]);
		expect(await transcriptUsage(file)).toEqual({ tokens: 40, requests: 1, cost: 0.002 });
	});

	test("a transcript with no assistant turn is unknown, not zero", async () => {
		const file = transcript([
			JSON.stringify({ type: "message", message: { role: "user", content: "hi" } }),
		]);
		expect(await transcriptUsage(file)).toBeUndefined();
	});

	test("a missing transcript is unknown", async () => {
		expect(
			await transcriptUsage(join(tempDir("omp-transcript-missing-"), "gone.jsonl")),
		).toBeUndefined();
	});
});
