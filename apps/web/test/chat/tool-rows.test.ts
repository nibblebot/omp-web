import { describe, expect, test } from "bun:test";
import { capRows, toolRowLimit } from "../../chat/tool-rows";

const rows = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("toolRowLimit", () => {
	test("counts are numbers and all lifts the cap", () => {
		expect(toolRowLimit("10")).toBe(10);
		expect(toolRowLimit("20")).toBe(20);
		expect(toolRowLimit("40")).toBe(40);
		expect(toolRowLimit("all")).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("capRows", () => {
	test("head keeps the first rows (read)", () => {
		expect(capRows(rows(25), 10, "head")).toEqual({ shown: rows(10), hidden: 15 });
	});

	test("tail keeps the last rows (bash, eval)", () => {
		expect(capRows(rows(25), 10, "tail")).toEqual({
			shown: [16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
			hidden: 15,
		});
	});

	test("a cap at or past the row count hides nothing", () => {
		expect(capRows(rows(10), 10, "head")).toEqual({ shown: rows(10), hidden: 0 });
		expect(capRows(rows(3), 20, "tail")).toEqual({ shown: rows(3), hidden: 0 });
	});

	test("all shows every row from either end", () => {
		const limit = toolRowLimit("all");
		expect(capRows(rows(500), limit, "head")).toEqual({ shown: rows(500), hidden: 0 });
		expect(capRows(rows(500), limit, "tail")).toEqual({ shown: rows(500), hidden: 0 });
	});

	test("no rows is empty", () => {
		expect(capRows([], 10, "tail")).toEqual({ shown: [], hidden: 0 });
	});
});
