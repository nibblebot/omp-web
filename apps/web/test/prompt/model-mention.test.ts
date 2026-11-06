import { describe, expect, test } from "bun:test";
import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { currentToken } from "../../prompt/autocomplete";
import { modelMentionRows } from "../../prompt/model-mention";

function entry(
	provider: string,
	id: string,
	extra: Partial<ModelBrowserEntry> = {},
): ModelBrowserEntry {
	return { provider, id, kind: "chat", contextWindow: 200_000, reasoning: false, ...extra };
}

const models: ModelBrowserEntry[] = [
	entry("anthropic", "claude-opus-5-5", {
		reasoning: true,
		thinkingEfforts: ["low", "medium", "high", "xhigh"],
	}),
	entry("anthropic", "claude-haiku-5-5"),
	entry("openai", "gpt-5.2", {
		reasoning: true,
		thinkingEfforts: ["minimal", "low", "medium", "high"],
	}),
	entry("openai", "gpt-locked", { locked: "credentials", thinkingEfforts: ["high"] }),
	entry("web", "exa", { kind: "search" }),
];

const values = (query: string, catalog = models, recent: string[] = []) =>
	modelMentionRows(query, catalog, recent).map((row) => row.value);

describe("currentToken for ^", () => {
	test("^ after start or whitespace is a model token", () => {
		expect(currentToken("^open", 5)).toEqual({ mode: "model", query: "open", start: 0, end: 5 });
		expect(currentToken("ask ^openai/gpt-5.2:hi", 22)).toEqual({
			mode: "model",
			query: "openai/gpt-5.2:hi",
			start: 4,
			end: 22,
		});
	});

	test("a ^ inside a word is not a token", () => {
		expect(currentToken("2^10", 4)).toBeNull();
	});
});

describe("modelMentionRows", () => {
	test("a bare ^ lists usable chat models only", () => {
		const list = values("");
		expect(list).toEqual([
			"anthropic/claude-haiku-5-5",
			"anthropic/claude-opus-5-5",
			"openai/gpt-5.2",
		]);
		expect(list).not.toContain("openai/gpt-locked");
		expect(list).not.toContain("web/exa");
	});

	test("recent models lead an empty query", () => {
		expect(values("", models, ["openai/gpt-5.2"])[0]).toBe("openai/gpt-5.2");
	});

	test("the query filters and ranks models", () => {
		expect(values("opus")).toEqual(["anthropic/claude-opus-5-5"]);
		expect(modelMentionRows("opus", models, [])[0]?.detail).toBe("ctx 200k");
	});

	test("after the colon, the model's supported efforts are listed in order", () => {
		expect(values("openai/gpt-5.2:")).toEqual([
			"openai/gpt-5.2:minimal",
			"openai/gpt-5.2:low",
			"openai/gpt-5.2:medium",
			"openai/gpt-5.2:high",
		]);
		expect(modelMentionRows("openai/gpt-5.2:", models, [])[0]?.detail).toBe("gpt-5.2 · minimal");
	});

	test("typed text after the colon narrows the levels by prefix", () => {
		expect(values("openai/gpt-5.2:m")).toEqual(["openai/gpt-5.2:minimal", "openai/gpt-5.2:medium"]);
		expect(values("anthropic/claude-opus-5-5:x")).toEqual(["anthropic/claude-opus-5-5:xhigh"]);
	});

	test("a model that does not reason offers no levels", () => {
		expect(values("anthropic/claude-haiku-5-5:")).toEqual([]);
	});

	test("an unknown model offers nothing", () => {
		expect(values("nope/missing:")).toEqual([]);
		expect(values("nope/missing")).toEqual([]);
	});

	test("a locked model offers no levels", () => {
		expect(values("openai/gpt-locked:")).toEqual([]);
	});

	test("a level-looking id suffix lists the real model first and drops the duplicate level row", () => {
		const catalog = [
			entry("zai", "glm-4.7", { reasoning: true, thinkingEfforts: ["low", "max"] }),
			entry("zai", "glm-4.7:max"),
		];
		expect(values("zai/glm-4.7:max", catalog)).toEqual(["zai/glm-4.7:max"]);
		expect(values("zai/glm-4.7:", catalog)).toEqual(["zai/glm-4.7:max", "zai/glm-4.7:low"]);
	});

	test("the list is capped at 20 rows", () => {
		const many = Array.from({ length: 30 }, (_, i) => entry("p", `model-${i}`));
		expect(modelMentionRows("", many, [])).toHaveLength(20);
	});

	describe("with a session model scope", () => {
		const scopedCatalog = models.map((model) =>
			model.id === "claude-opus-5-5" || model.id === "claude-haiku-5-5"
				? { ...model, scoped: true as const }
				: model,
		);

		test("lists only the scoped models when rows are marked", () => {
			expect(values("", scopedCatalog).sort()).toEqual([
				"anthropic/claude-haiku-5-5",
				"anthropic/claude-opus-5-5",
			]);
			expect(values("gpt", scopedCatalog)).toEqual([]);
		});

		test("lists every usable chat model when no row is marked", () => {
			expect(values("")).toHaveLength(3);
			expect(values("gpt")).toEqual(["openai/gpt-5.2"]);
		});

		test("offers levels after the colon only for scoped models", () => {
			expect(values("anthropic/claude-opus-5-5:", scopedCatalog)).toEqual([
				"anthropic/claude-opus-5-5:low",
				"anthropic/claude-opus-5-5:medium",
				"anthropic/claude-opus-5-5:high",
				"anthropic/claude-opus-5-5:xhigh",
			]);
			expect(values("openai/gpt-5.2:", scopedCatalog)).toEqual([]);
		});

		test("a level row naming an unscoped usable model is still dropped", () => {
			const catalog = [
				entry("zai", "glm-4.7", { reasoning: true, thinkingEfforts: ["low", "max"], scoped: true }),
				entry("zai", "glm-4.7:max"),
			];
			expect(values("zai/glm-4.7:", catalog)).toEqual(["zai/glm-4.7:low"]);
		});
	});
});
