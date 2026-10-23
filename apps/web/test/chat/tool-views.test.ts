import { describe, expect, test } from "bun:test";
import { parseReadOutput } from "../../components/chat/tools/read-view";
import { parseGrepOutput } from "../../components/chat/tools/search-view";

describe("parseReadOutput", () => {
	test("hashline output: header dropped, SDK numbers kept, indent preserved", () => {
		const out = "[src/a.ts#7k2m]\n5:const a = 1;\n6:  indented\n7:";
		const { numbered, rows } = parseReadOutput(out, 1);
		expect(numbered).toBe(true);
		expect(rows).toEqual([
			{ no: 5, text: "const a = 1;", code: true },
			{ no: 6, text: "  indented", code: true },
			{ no: 7, text: "", code: true },
		]);
	});

	test("plain `N|` numbering and a trailing notice that is not code", () => {
		const out = "1|a\n2|b\n\n[3 more lines in file. Use a.ts:3 to continue]";
		const { numbered, rows } = parseReadOutput(out, 1);
		expect(numbered).toBe(true);
		expect(rows.map((r) => [r.no, r.text, r.code])).toEqual([
			[1, "a", true],
			[2, "b", true],
			[null, "", false],
			[null, "[3 more lines in file. Use a.ts:3 to continue]", false],
		]);
	});

	test("jumps in numbering (elided context) keep their own numbers", () => {
		const { rows } = parseReadOutput("1:a\n2:b\n…\n9:z", 1);
		expect(rows.map((r) => r.no)).toEqual([1, 2, null, 9]);
		expect(rows[2].code).toBe(false);
	});

	test("unnumbered output is numbered from the offset; trailing blank rows drop", () => {
		const { numbered, rows } = parseReadOutput("alpha\nbeta\n", 40);
		expect(numbered).toBe(false);
		expect(rows).toEqual([
			{ no: 40, text: "alpha", code: true },
			{ no: 41, text: "beta", code: true },
		]);
	});
});

describe("parseGrepOutput", () => {
	test("grouped output rebuilds full paths from folded headers and drops #TAG", () => {
		const out = [
			"# apps/web/",
			"## a/",
			"### One.ts#abcd",
			"*3:const x = 1;",
			" 4:ctx",
			"",
			"## Two.ts",
			"*9|plain",
		].join("\n");
		expect(parseGrepOutput(out)).toEqual([
			{ kind: "file", path: "apps/web/a/One.ts" },
			{
				kind: "line",
				path: "apps/web/a/One.ts",
				no: 3,
				mark: true,
				text: "const x = 1;",
				col: undefined,
			},
			{ kind: "line", path: "apps/web/a/One.ts", no: 4, mark: false, text: "ctx", col: undefined },
			{ kind: "file", path: "apps/web/Two.ts" },
			{ kind: "line", path: "apps/web/Two.ts", no: 9, mark: true, text: "plain", col: undefined },
		]);
	});

	test("a sibling dir header pops deeper levels", () => {
		const rows = parseGrepOutput("# r/\n## a/\n### x.ts\n*1:a\n\n## b/\n### y.ts\n*2:b");
		expect(rows.filter((r) => r.kind === "file")).toEqual([
			{ kind: "file", path: "r/a/x.ts" },
			{ kind: "file", path: "r/b/y.ts" },
		]);
	});

	test("flat output: [path#TAG] header or args.path fallback, gaps and notes", () => {
		const hashed = parseGrepOutput(
			"[src/a.py#1f2e]\n*10:def f():\n...\n*20:  return 1\n\nNote text",
		);
		expect(hashed.map((r) => r.kind)).toEqual(["file", "line", "gap", "line", "text"]);
		expect(hashed[0]).toEqual({ kind: "file", path: "src/a.py" });

		const bare = parseGrepOutput(" 1|a\n*2|b", "src/a.py");
		expect(bare).toEqual([
			{ kind: "line", path: "src/a.py", no: 1, mark: false, text: "a", col: undefined },
			{ kind: "line", path: "src/a.py", no: 2, mark: true, text: "b", col: undefined },
		]);
		expect(parseGrepOutput("│...")).toEqual([{ kind: "gap" }]);
	});

	test("the SDK's ` [col N]` suffix on a cut match line is split off", () => {
		const [row] = parseGrepOutput("*7:const long = 1; [col 42]");
		expect(row).toMatchObject({ kind: "line", no: 7, text: "const long = 1;", col: 42 });
	});

	test("errors and limit messages stay text rows", () => {
		expect(parseGrepOutput("regex parse error: unclosed group")).toEqual([
			{ kind: "text", text: "regex parse error: unclosed group" },
		]);
	});
});
