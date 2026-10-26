import { describe, expect, test } from "bun:test";
import type { ModelBrowserEntry, ModelLockReason } from "#lib/wire/protocol";
import { rankModels, splitSelectorThinking, thinkingLabel } from "../../usage/model-search";

/** Browser row fixture; only the fields the ranking reads are set. */
function entry(provider: string, id: string, locked?: ModelLockReason): ModelBrowserEntry {
	return {
		provider,
		id,
		contextWindow: 128_000,
		reasoning: false,
		...(locked === undefined ? {} : { locked }),
	} as ModelBrowserEntry;
}

const models: ModelBrowserEntry[] = [
	entry("anthropic", "claude-sonnet-4"),
	entry("anthropic", "claude-opus-4-1"),
	entry("openai", "gpt-5", "credentials"),
	entry("ollama", "qwen3:8b"),
];

describe("rankModels", () => {
	test("empty query lists usable recent rows first, in recent order, then provider/id order", () => {
		const ranked = rankModels(models, "", ["ollama/qwen3:8b", "anthropic/claude-sonnet-4"]);
		expect(ranked.map((row) => row.selector)).toEqual([
			"ollama/qwen3:8b",
			"anthropic/claude-sonnet-4",
			"anthropic/claude-opus-4-1",
			"openai/gpt-5",
		]);
		expect(ranked[0]?.recent).toBe(true);
		expect(ranked[1]?.recent).toBe(true);
		expect(ranked[2]?.recent).toBe(false);
	});

	test("fuzzy query matches on the selector and on the bare id", () => {
		const ranked = rankModels(models, "opus", []);
		expect(ranked[0]?.selector).toBe("anthropic/claude-opus-4-1");
		const bySubsequence = rankModels(models, "cs4", []);
		expect(bySubsequence.map((row) => row.selector)).toContain("anthropic/claude-sonnet-4");
	});

	test("query ignores a trailing thinking suffix", () => {
		const ranked = rankModels(models, "opus:high", []);
		expect(ranked[0]?.selector).toBe("anthropic/claude-opus-4-1");
	});

	test("locked rows always sort after usable rows, with their reason kept", () => {
		const ranked = rankModels(models, "", []);
		const last = ranked[ranked.length - 1];
		expect(last?.selector).toBe("openai/gpt-5");
		expect(last?.model.locked).toBe("credentials");
	});

	test("with a query, the current model wins a score tie", () => {
		const ranked = rankModels(
			[entry("anthropic", "sonnet-a"), entry("openai", "sonnet-a")],
			"sonnet-a",
			[],
			"openai/sonnet-a",
		);
		expect(ranked[0]?.selector).toBe("openai/sonnet-a");
	});
});

describe("splitSelectorThinking", () => {
	test("splits a known thinking suffix off the selector", () => {
		expect(splitSelectorThinking("anthropic/x:high")).toEqual({
			selector: "anthropic/x",
			thinking: "high",
		});
	});

	test("keeps an ollama id with its own colon intact", () => {
		expect(splitSelectorThinking("ollama/qwen3:8b")).toEqual({ selector: "ollama/qwen3:8b" });
	});

	test("leaves a selector without a suffix unchanged", () => {
		expect(splitSelectorThinking("anthropic/x")).toEqual({ selector: "anthropic/x" });
	});
});

describe("thinkingLabel", () => {
	test("minimal renders as min; other levels are their wire value", () => {
		expect(thinkingLabel("minimal")).toBe("min");
		expect(thinkingLabel("low")).toBe("low");
		expect(thinkingLabel("xhigh")).toBe("xhigh");
	});
});
