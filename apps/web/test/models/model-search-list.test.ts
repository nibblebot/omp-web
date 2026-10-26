import { describe, expect, test } from "bun:test";
import type { ModelBrowserEntry } from "#lib/wire/protocol";
import { moveCursor } from "../../components/models/ModelSearchList";
import { filterByKinds, virtualWindow } from "../../usage/model-query";

describe("moveCursor (keyboard reach through the model list)", () => {
	test("steps forward and back, wrapping at both ends", () => {
		expect(moveCursor(0, 3, 1)).toBe(1);
		expect(moveCursor(2, 3, 1)).toBe(0);
		expect(moveCursor(0, 3, -1)).toBe(2);
	});

	test("clamps a cursor past the end before stepping, and is 0 with no selectable rows", () => {
		expect(moveCursor(9, 3, 1)).toBe(0);
		expect(moveCursor(0, 0, 1)).toBe(0);
	});
});

function entry(provider: string, id: string, kind: ModelBrowserEntry["kind"]): ModelBrowserEntry {
	return { provider, id, kind, contextWindow: 0, reasoning: false } as ModelBrowserEntry;
}

const models: ModelBrowserEntry[] = [
	entry("anthropic", "claude-sonnet-4", "chat"),
	entry("anthropic", "claude-opus-4-1", "chat"),
	entry("openai", "gpt-5", "chat"),
	entry("openai", "gpt-image-1", "image"),
	entry("openai", "tts-1", "tts"),
];

describe("filterByKinds", () => {
	test("keeps only the listed kinds; absent keeps every row", () => {
		expect(filterByKinds(models, ["chat"]).map((m) => m.id)).toEqual([
			"claude-sonnet-4",
			"claude-opus-4-1",
			"gpt-5",
		]);
		expect(filterByKinds(models, ["image", "tts"]).map((m) => m.id)).toEqual([
			"gpt-image-1",
			"tts-1",
		]);
		expect(filterByKinds(models, undefined)).toBe(models);
	});
});

describe("virtualWindow (rows mounted for the viewport)", () => {
	test("covers the viewport plus overscan, clamped at the top", () => {
		// 300px viewport, 30px rows: 11 rows cover it, then 8 overscan below.
		expect(virtualWindow(0, 300, 30, 5000)).toEqual({ start: 0, end: 19 });
	});

	test("follows the scroll position with overscan on both sides", () => {
		// Row 100 is first visible.
		expect(virtualWindow(3000, 300, 30, 5000)).toEqual({ start: 92, end: 119 });
	});

	test("clamps to the end of the list, even scrolled past it", () => {
		expect(virtualWindow(149_700, 300, 30, 5000)).toEqual({ start: 4982, end: 5000 });
		expect(virtualWindow(999_999, 300, 30, 5000)).toEqual({ start: 4991, end: 5000 });
	});

	test("mounts nothing for an empty list", () => {
		expect(virtualWindow(0, 300, 30, 0)).toEqual({ start: 0, end: 0 });
	});
});
