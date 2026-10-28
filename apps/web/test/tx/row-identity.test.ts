/**
 * Row identity for the Analysis transcript: rows are keyed by entry object, so
 * rebuilding the row list (page append, filter, live tail) must hand back the same
 * row object for an entry that is still listed, and a live re-fetch of unchanged
 * lines must keep the entries it already holds.
 */
import { describe, expect, test } from "bun:test";
import type { RawEntry } from "../../store/fleet-api";
import { buildDayRows, createRowCache } from "../../tx/components/transcript/day-rows";
import { reuseEqualEntries, searchTextOf } from "../../tx/util/entries";

const at = (id: string, iso: string): RawEntry => ({
	type: "message",
	id,
	timestamp: iso,
	message: { role: "user", content: [{ type: "text", text: `text ${id}` }] },
});

describe("buildDayRows with a cache", () => {
	const a = at("a", "2026-03-01T10:00:00");
	const b = at("b", "2026-03-01T11:00:00");
	const c = at("c", "2026-03-02T10:00:00");

	test("an entry and a day separator keep their row object across rebuilds", () => {
		const cache = createRowCache();
		const first = buildDayRows([a, b, c], cache);
		const second = buildDayRows([a, b, c, at("d", "2026-03-02T12:00:00")], cache);
		expect(first.map((r) => r.kind)).toEqual(["entry", "entry", "day", "entry"]);
		for (let i = 0; i < first.length; i++) expect(second[i]).toBe(first[i]!);
	});

	test("filtering drops rows without disturbing the survivors", () => {
		const cache = createRowCache();
		const all = buildDayRows([a, b, c], cache);
		const some = buildDayRows([b, c], cache);
		expect(some[0]).toBe(all[1]!);
		expect(some[some.length - 1]).toBe(all[all.length - 1]!);
	});

	test("without a cache every call builds fresh rows", () => {
		expect(buildDayRows([a])[0]).not.toBe(buildDayRows([a])[0]!);
	});
});

describe("reuseEqualEntries", () => {
	test("keeps the old object for an unchanged entry and takes the fresh one for a changed or new entry", () => {
		const old = [at("a", "2026-03-01T10:00:00"), at("b", "2026-03-01T11:00:00")];
		const fresh = [
			at("a", "2026-03-01T10:00:00"),
			{ ...at("b", "2026-03-01T11:00:00"), extra: 1 },
			at("c", "2026-03-01T12:00:00"),
		];
		const out = reuseEqualEntries(old, fresh);
		expect(out[0]).toBe(old[0]!);
		expect(out[1]).toBe(fresh[1]!);
		expect(out[1]).not.toBe(old[1]!);
		expect(out).toHaveLength(3);
	});
});

describe("searchTextOf", () => {
	test("is the lowercased entry JSON, and built once per entry", () => {
		const e = at("Needle", "2026-03-01T10:00:00");
		const text = searchTextOf(e);
		expect(text).toContain("needle");
		expect(text).not.toContain("Needle");
		expect(searchTextOf(e)).toBe(text);
	});
});
