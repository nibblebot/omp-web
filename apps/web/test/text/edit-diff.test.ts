import { describe, expect, test } from "bun:test";
import { editPreview, splitRows } from "../../text/edit-diff";

describe("editPreview", () => {
	test("reads SDK replace args (old_string/new_string)", () => {
		const p = editPreview("edit", { path: "a.ts", old_string: "x\ny", new_string: "x\nz" });
		expect(p?.path).toBe("a.ts");
		expect(p?.added).toBe(1);
		expect(p?.removed).toBe(1);
		expect(p?.rows).toEqual([
			{ type: "context", text: "x" },
			{ type: "del", text: "y" },
			{ type: "add", text: "z" },
		]);
	});

	test("reads batch edits and legacy oldText/newText pairs", () => {
		const batch = editPreview("edit", {
			path: "a.ts",
			edits: [
				{ old_string: "a", new_string: "b" },
				{ old_string: "c", new_string: "d" },
			],
		});
		expect(batch?.added).toBe(2);
		expect(batch?.removed).toBe(2);
		const legacy = editPreview("edit", {
			path: "a.ts",
			edits: [{ oldText: "a", newText: "a\nb" }],
		});
		expect(legacy?.added).toBe(1);
		expect(legacy?.removed).toBe(0);
	});

	test("skips partially streamed edit entries", () => {
		const p = editPreview("edit", {
			path: "a.ts",
			edits: [{ old_string: "a", new_string: "b" }, { old_string: "half" }],
		});
		expect(p?.added).toBe(1);
		expect(p?.removed).toBe(1);
	});

	test("write renders the whole content as added lines", () => {
		const p = editPreview("write", { path: "n.txt", content: "one\ntwo" });
		expect(p).toMatchObject({ path: "n.txt", added: 2, removed: 0 });
		expect(p?.rows.every((r) => r.type === "add")).toBe(true);
	});

	test("parses compact details.diff for patch-style tools", () => {
		const details = { diff: "+12|new line\n-11|old line\n 10|same\n…" };
		const p = editPreview("apply_patch", { input: "*** Begin Patch" }, details);
		expect(p).toMatchObject({ path: null, added: 1, removed: 1 });
		expect(p?.rows).toEqual([
			{ type: "add", text: "new line" },
			{ type: "del", text: "old line" },
			{ type: "context", text: "same" },
		]);
	});

	test("counts files from perFileResults in details", () => {
		const details = { diff: "+1|a", perFileResults: [{ path: "a" }, { path: "b" }] };
		expect(editPreview("apply_patch", { input: "" }, details)?.files).toBe(2);
	});

	test("returns null when nothing is renderable (no raw-args fallback)", () => {
		expect(editPreview("edit", { path: 42 })).toBeNull();
		expect(editPreview("edit", null)).toBeNull();
		expect(editPreview("write", { path: "x" })).toBeNull();
		expect(editPreview("hashline", { input: "@@" })).toBeNull();
	});
});

describe("splitRows", () => {
	test("zips removed and added runs side by side", () => {
		const rows = splitRows([
			{ type: "context", text: "a" },
			{ type: "del", text: "b" },
			{ type: "del", text: "c" },
			{ type: "add", text: "x" },
		]);
		expect(rows).toEqual([
			{ left: { type: "context", text: "a" }, right: { type: "context", text: "a" } },
			{ left: { type: "del", text: "b" }, right: { type: "add", text: "x" } },
			{ left: { type: "del", text: "c" }, right: null },
		]);
	});
});
