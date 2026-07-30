import { describe, expect, test } from "bun:test";
import { PromptHistory, type HistoryStorage } from "./history";

function memStorage(initial?: string): HistoryStorage & { value: string | null } {
	return {
		value: initial ?? null,
		getItem() {
			return this.value;
		},
		setItem(_key, v) {
			this.value = v;
		},
	};
}

describe("PromptHistory", () => {
	test("push persists and dedupes consecutive entries", () => {
		const storage = memStorage();
		const h = new PromptHistory(storage);
		h.push("one");
		h.push("one");
		h.push("two");
		expect(h.size).toBe(2);
		expect(JSON.parse(storage.value ?? "[]")).toEqual(["one", "two"]);
	});

	test("caps at 100 entries, dropping oldest", () => {
		const h = new PromptHistory(memStorage());
		for (let i = 0; i < 105; i++) h.push(`p${i}`);
		expect(h.size).toBe(100);
		expect(h.prev("")).toBe("p104");
	});

	test("prev walks older, next returns to the stashed draft", () => {
		const h = new PromptHistory(memStorage());
		h.push("a");
		h.push("b");
		expect(h.prev("draft")).toBe("b");
		expect(h.prev("ignored")).toBe("a");
		expect(h.prev("ignored")).toBe("a"); // clamps at oldest
		expect(h.next()).toBe("b");
		expect(h.next()).toBe("draft"); // past newest restores the draft
		expect(h.browsing).toBe(false);
	});

	test("push resets browsing state", () => {
		const h = new PromptHistory(memStorage());
		h.push("a");
		h.prev("x");
		expect(h.browsing).toBe(true);
		h.push("b");
		expect(h.browsing).toBe(false);
	});

	test("empty history recalls nothing", () => {
		const h = new PromptHistory(memStorage());
		expect(h.prev("x")).toBeNull();
		expect(h.next()).toBeNull();
	});

	test("loads persisted entries and ignores corrupt JSON", () => {
		expect(new PromptHistory(memStorage('["x","y"]')).size).toBe(2);
		expect(new PromptHistory(memStorage("{oops")).size).toBe(0);
	});
});
