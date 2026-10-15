import { describe, expect, test } from "bun:test";
import { PromptHistory, type HistoryStorage } from "../../prompt/history";

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
		expect(h.list()[0]).toBe("p104");
		expect(h.list().at(-1)).toBe("p5");
	});

	test("loads persisted entries and ignores corrupt JSON", () => {
		expect(new PromptHistory(memStorage('["x","y"]')).size).toBe(2);
		expect(new PromptHistory(memStorage("{oops")).size).toBe(0);
	});
});
