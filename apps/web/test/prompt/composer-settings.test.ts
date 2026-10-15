import { describe, expect, test } from "bun:test";
import { clampMaxVisible } from "../../components/chat/composer/usePromptAutocomplete";
import { PASTE_LARGE_MENU_DEFAULT, shouldFoldPaste } from "../../prompt/paste";

const lines = (count: number): string =>
	Array.from({ length: count }, (_, i) => `line ${i}`).join("\n");

describe("clampMaxVisible (autocompleteMaxVisible)", () => {
	test("falls back to the TUI default of 10 when unset or not finite", () => {
		expect(clampMaxVisible(undefined)).toBe(10);
		expect(clampMaxVisible(Number.NaN)).toBe(10);
		expect(clampMaxVisible(Number.POSITIVE_INFINITY)).toBe(10);
	});

	test("clamps to the TUI editor range 3..20", () => {
		expect(clampMaxVisible(0)).toBe(3);
		expect(clampMaxVisible(1)).toBe(3);
		expect(clampMaxVisible(50)).toBe(20);
	});

	test("rounds fractional values and keeps in-range values", () => {
		expect(clampMaxVisible(7.6)).toBe(8);
		expect(clampMaxVisible(7)).toBe(7);
	});
});

describe("shouldFoldPaste (paste.largeMenuThreshold)", () => {
	test("default threshold is the TUI default of 100 lines", () => {
		expect(PASTE_LARGE_MENU_DEFAULT).toBe(100);
		expect(shouldFoldPaste(lines(99), PASTE_LARGE_MENU_DEFAULT)).toBe(false);
		expect(shouldFoldPaste(lines(100), PASTE_LARGE_MENU_DEFAULT)).toBe(true);
	});

	test("0 disables folding entirely", () => {
		expect(shouldFoldPaste(lines(500), 0)).toBe(false);
	});

	test("a lower threshold folds shorter pastes", () => {
		expect(shouldFoldPaste(lines(5), 5)).toBe(true);
		expect(shouldFoldPaste(lines(4), 5)).toBe(false);
	});
});
