import { describe, expect, test } from "bun:test";
import { ReplayRing } from "#lib/wire/replay-ring";

describe("ReplayRing", () => {
	test("evicts oldest beyond cap", () => {
		const ring = new ReplayRing<number>(3);
		for (let seq = 1; seq <= 5; seq++) ring.push(seq, seq * 10);
		expect(ring.size).toBe(3);
		expect(ring.after(0).map((e) => e.seq)).toEqual([3, 4, 5]);
	});

	test("after returns only newer entries, oldest first", () => {
		const ring = new ReplayRing<string>(10);
		for (let seq = 10; seq <= 14; seq++) ring.push(seq, `s${seq}`);
		expect(ring.after(12).map((e) => [e.seq, e.value])).toEqual([
			[13, "s13"],
			[14, "s14"],
		]);
		expect(ring.after(14)).toEqual([]);
	});

	test("byte budget evicts oldest entries from the head (finding #5)", () => {
		const ring = new ReplayRing<string>(100, 30);
		ring.push(1, "a".repeat(8)); // 8
		ring.push(2, "b".repeat(8)); // 16
		ring.push(3, "c".repeat(10)); // 26
		ring.push(4, "d".repeat(10)); // 36 > 30 → evict entry 1 (8) → 28
		expect(ring.size).toBe(3);
		expect(ring.bytes).toBe(28);
		expect(ring.after(0).map((e) => e.seq)).toEqual([2, 3, 4]);
	});

	test("a single entry larger than the whole budget still lands", () => {
		const ring = new ReplayRing<string>(10, 10);
		ring.push(1, "small"); // 5
		ring.push(2, "x".repeat(100)); // 100 > 10 → evicts entry 1, keeps the newest
		expect(ring.size).toBe(1);
		expect(ring.after(0).map((e) => e.seq)).toEqual([2]);
	});

	test("after() stays correct across byte eviction (replay skips evicted, keeps newer)", () => {
		const ring = new ReplayRing<string>(100, 50);
		ring.push(1, "a".repeat(30));
		ring.push(2, "b".repeat(30)); // 60 > 50 → evict 1
		ring.push(3, "c".repeat(30)); // 60 > 50 → evict 2
		// Eviction left a gap, but after() is still correct: it returns every
		// RINGED entry newer than the id (missing ones are re-derivable,
		// drop-and-resume, never a corrupted tail).
		expect(ring.after(1).map((e) => e.seq)).toEqual([3]);
		expect(ring.after(2).map((e) => e.seq)).toEqual([3]);
		ring.push(4, "d".repeat(10)); // 40 ≤ 50
		expect(ring.after(2).map((e) => e.seq)).toEqual([3, 4]);
		expect(ring.after(3).map((e) => e.seq)).toEqual([4]);
		expect(ring.after(4)).toEqual([]);
	});
});

describe("ReplayRing UTF-8 byte budget", () => {
	test("counts UTF-8 bytes, not UTF-16 code units", () => {
		// "é" is one code unit but two UTF-8 bytes: ten of them are 20 bytes.
		const ring = new ReplayRing<string>(100, 30);
		ring.push(1, "é".repeat(10)); // 20 bytes
		ring.push(2, "é".repeat(10)); // 40 > 30 → evict entry 1
		expect(ring.bytes).toBe(20);
		expect(ring.after(0).map((e) => e.seq)).toEqual([2]);
	});
});
