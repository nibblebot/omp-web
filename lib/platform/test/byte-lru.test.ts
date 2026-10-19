import { describe, expect, test } from "bun:test";
import { ByteLru } from "#lib/platform/byte-lru";

// ByteLru bounds caches by estimated bytes, not entry count (FPS-07 / FLC-17):
// a count cap evicted hot entries during sweeps over more files than the cap
// and let a few huge entries pin unbounded memory.
describe("ByteLru", () => {
	test("evicts least recently used entries until the total fits the byte budget", () => {
		const c = new ByteLru<string>({ maxBytes: 100, maxEntryBytes: 100 });
		c.set("a", "A", 40);
		c.set("b", "B", 40);
		expect(c.get("a")).toBe("A"); // refresh a → b is now oldest
		c.set("c", "C", 40); // 120 > 100 → evicts b
		expect(c.get("b")).toBeUndefined();
		expect(c.get("a")).toBe("A");
		expect(c.get("c")).toBe("C");
		expect(c.bytes).toBe(80);
		expect(c.size).toBe(2);
	});

	test("one huge entry evicts many small ones and is itself retained only within budget", () => {
		const c = new ByteLru<string>({ maxBytes: 100, maxEntryBytes: 100 });
		for (const k of ["a", "b", "c"]) c.set(k, k, 10);
		expect(c.set("big", "BIG", 100)).toBe(true); // exactly the budget → evicts every small entry
		expect(c.size).toBe(1);
		expect(c.get("big")).toBe("BIG");
		expect(c.bytes).toBe(100);
	});

	test("an entry above maxEntryBytes is refused and drops any previous value for its key", () => {
		const c = new ByteLru<string>({ maxBytes: 1000, maxEntryBytes: 50 });
		expect(c.set("k", "old", 20)).toBe(true);
		expect(c.set("k", "new", 60)).toBe(false);
		expect(c.get("k")).toBeUndefined();
		expect(c.bytes).toBe(0);
	});

	test("set replaces the value for a key without double-counting bytes", () => {
		const c = new ByteLru<number>({ maxBytes: 100, maxEntryBytes: 100 });
		c.set("k", 1, 30);
		c.set("k", 2, 50);
		expect(c.get("k")).toBe(2);
		expect(c.size).toBe(1);
		expect(c.bytes).toBe(50);
	});

	test("delete and clear release bytes", () => {
		const c = new ByteLru<number>({ maxBytes: 100, maxEntryBytes: 100 });
		c.set("a", 1, 30);
		c.set("b", 2, 30);
		c.delete("a");
		expect(c.bytes).toBe(30);
		c.clear();
		expect(c.size).toBe(0);
		expect(c.bytes).toBe(0);
	});

	test("limits given as a function are read on each set (test seam)", () => {
		let max = 10;
		const c = new ByteLru<string>(() => ({ maxBytes: max, maxEntryBytes: max }));
		expect(c.set("a", "A", 8)).toBe(true);
		max = 4;
		expect(c.set("b", "B", 8)).toBe(false);
	});
});
