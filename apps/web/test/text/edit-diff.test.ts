import { describe, expect, test } from "bun:test";
import { editPreview, highlightDiffRows } from "../../text/edit-diff";

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

	test("a single section carries the call's path and all rows", () => {
		const p = editPreview("edit", { path: "a.ts", old_string: "x", new_string: "y" });
		expect(p?.sections).toEqual([{ path: "a.ts", rows: p?.rows ?? [] }]);
	});

	test("splits rows per file when perFileResults cover the combined diff", () => {
		const details = {
			diff: "-1|a\n+1|b\n+1|c",
			perFileResults: [
				{ path: "x.ts", diff: "-1|a\n+1|b" },
				{ path: "y.py", diff: "+1|c" },
			],
		};
		const p = editPreview("apply_patch", { input: "" }, details);
		expect(p?.sections.map((s) => [s.path, s.rows.length])).toEqual([
			["x.ts", 2],
			["y.py", 1],
		]);
	});

	test("keeps one section when per-file results do not match the combined diff", () => {
		const details = {
			diff: "-1|a\n+1|b",
			perFileResults: [{ path: "x.ts" }, { path: "y.py", diff: "+1|c" }],
		};
		expect(editPreview("apply_patch", { input: "" }, details)?.sections).toHaveLength(1);
	});

	test("returns null when nothing is renderable (no raw-args fallback)", () => {
		expect(editPreview("edit", { path: 42 })).toBeNull();
		expect(editPreview("edit", null)).toBeNull();
		expect(editPreview("write", { path: "x" })).toBeNull();
		expect(editPreview("hashline", { input: "@@" })).toBeNull();
	});
});

/**
 * Stand-in for highlightLines with whole-text semantics: lines inside a
 * block comment (across lines) become `<c>`, the rest `<p>`.
 */
function fakeHighlight(code: string): string[] {
	let inComment = false;
	return code.split("\n").map((line) => {
		const startsInComment = inComment;
		if (line.includes("/*")) inComment = true;
		if (line.includes("*/")) inComment = false;
		const tag = startsInComment || line.includes("/*") ? "c" : "p";
		return `<${tag}>${line}</${tag}>`;
	});
}

describe("highlightDiffRows", () => {
	test("del rows take the old side, add rows the new side, context the new side", () => {
		const seen: string[] = [];
		const html = highlightDiffRows(
			[
				{ type: "context", text: "a" },
				{ type: "del", text: "old" },
				{ type: "add", text: "new1" },
				{ type: "add", text: "new2" },
				{ type: "context", text: "z" },
			],
			(code) => {
				seen.push(code);
				return code.split("\n").map((l) => `[${l}]`);
			},
		);
		expect(seen).toEqual(["a\nold\nz", "a\nnew1\nnew2\nz"]);
		expect(html).toEqual(["[a]", "[old]", "[new1]", "[new2]", "[z]"]);
	});

	test("a block comment spanning context and add rows stays colored", () => {
		const html = highlightDiffRows(
			[
				{ type: "context", text: "/* header" },
				{ type: "add", text: " added note" },
				{ type: "context", text: " end */" },
				{ type: "add", text: "code()" },
			],
			fakeHighlight,
		);
		expect(html).toEqual([
			"<c>/* header</c>",
			"<c> added note</c>",
			"<c> end */</c>",
			"<p>code()</p>",
		]);
	});

	test("a comment opened only on the deleted side does not color added rows", () => {
		const html = highlightDiffRows(
			[
				{ type: "del", text: "/* gone" },
				{ type: "del", text: "still gone */" },
				{ type: "add", text: "live()" },
			],
			fakeHighlight,
		);
		expect(html).toEqual(["<c>/* gone</c>", "<c>still gone */</c>", "<p>live()</p>"]);
	});

	test("collapse rows map to null and an add-only diff highlights one side", () => {
		const calls: string[] = [];
		const html = highlightDiffRows(
			[
				{ type: "add", text: "a" },
				{ type: "collapse", count: 5 },
				{ type: "add", text: "b" },
			],
			(code) => {
				calls.push(code);
				return code.split("\n");
			},
		);
		expect(calls).toEqual(["a\nb"]);
		expect(html).toEqual(["a", null, "b"]);
	});

	test("returns null when the highlighter declines or returns a mismatched line count", () => {
		const rows = [{ type: "add", text: "a" }] as const;
		expect(highlightDiffRows([...rows], () => null)).toBeNull();
		expect(highlightDiffRows([...rows], () => ["x", "y"])).toBeNull();
	});
});
