import { describe, expect, test } from "bun:test";
import { truncateHead } from "./state";

describe("truncateHead (desktop-notification body cap)", () => {
	test("short text passes through unchanged", () => {
		expect(truncateHead("done")).toBe("done");
		expect(truncateHead("")).toBe("");
	});

	test("long text is cut to ~max code points", () => {
		const s = "a".repeat(200);
		expect(truncateHead(s)).toBe("a".repeat(80));
		expect(truncateHead(s, 20)).toBe("a".repeat(20));
	});

	test("text exactly at the cap is untouched", () => {
		const s = "x".repeat(80);
		expect(truncateHead(s)).toBe(s);
	});

	test("a surrogate pair at the boundary is never split", () => {
		// 79 ASCII chars + an emoji (2 code units): cut must include the pair whole.
		const s = "a".repeat(79) + "😀" + "b".repeat(40);
		const cut = truncateHead(s);
		expect(cut.endsWith("😀")).toBe(true);
		expect(cut.length).toBe(81);
		expect(truncateHead(s, 80)).toBe("a".repeat(79) + "😀");
	});
});
