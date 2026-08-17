import { describe, expect, test } from "bun:test";
import { buildDiffRows } from "./diff";

describe("buildDiffRows", () => {
	test("marks added and removed lines", () => {
		const rows = buildDiffRows("a\nb\nc", "a\nx\nc");
		expect(rows).toEqual([
			{ type: "context", text: "a" },
			{ type: "del", text: "b" },
			{ type: "add", text: "x" },
			{ type: "context", text: "c" },
		]);
	});

	test("collapses the middle of a long unchanged run", () => {
		const oldText = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
		const newText = oldText.replace("l10", "CHANGED");
		const rows = buildDiffRows(oldText, newText, 3);
		const collapse = rows.find((r) => r.type === "collapse");
		expect(collapse).toBeDefined();
		// 19 unchanged lines (10 before + 9 after); each run keeps 3 head + 3 tail
		const collapsedCount = rows
			.filter((r) => r.type === "collapse")
			.reduce((n, r) => n + (r.type === "collapse" ? r.count : 0), 0);
		expect(collapsedCount).toBe(19 - 12);
		expect(rows.filter((r) => r.type === "add")).toEqual([{ type: "add", text: "CHANGED" }]);
	});

	test("short unchanged runs are never collapsed", () => {
		const rows = buildDiffRows("a\nb\nc\nd", "a\nb\nX\nd", 3);
		expect(rows.every((r) => r.type !== "collapse")).toBe(true);
	});

	test("identical inputs render fully without collapse", () => {
		const text = Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n");
		const rows = buildDiffRows(text, text, 3);
		expect(rows).toHaveLength(30);
		expect(rows.every((r) => r.type === "context")).toBe(true);
	});

	test("empty old text: everything added", () => {
		const rows = buildDiffRows("", "a\nb");
		expect(rows).toEqual([
			{ type: "add", text: "a" },
			{ type: "add", text: "b" },
		]);
	});
});
