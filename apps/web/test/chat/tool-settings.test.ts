import { describe, expect, test } from "bun:test";
import { hasLineNumbers, isMarkitDocument } from "../../components/chat/tools/read-view";
import { isMarkdownMcpResult } from "../../components/chat/tools/mcp-markdown";

describe("isMarkdownMcpResult (mcp.renderMarkdownResults)", () => {
	test("non-JSON text from an MCP tool is eligible", () => {
		expect(isMarkdownMcpResult("mcp__github_search", "# Results\n- one")).toBe(true);
	});

	test("JSON documents stay plain", () => {
		expect(isMarkdownMcpResult("mcp__github_search", '{"ok": true}')).toBe(false);
		expect(isMarkdownMcpResult("mcp__github_search", "[1, 2, 3]")).toBe(false);
	});

	test("bracket-led text that is not JSON stays eligible", () => {
		expect(isMarkdownMcpResult("mcp__github_search", "[link](https://x)")).toBe(true);
	});

	test("empty output and non-MCP tools are not rendered as Markdown", () => {
		expect(isMarkdownMcpResult("mcp__github_search", "  \n ")).toBe(false);
		expect(isMarkdownMcpResult("bash", "# not mcp")).toBe(false);
	});
});

describe("hasLineNumbers (SDK read numbering)", () => {
	test("majority of numbered lines marks the output as numbered", () => {
		expect(hasLineNumbers("1→alpha\n2→beta\n3→gamma")).toBe(true);
	});

	test("plain text and empty output are not numbered", () => {
		expect(hasLineNumbers("alpha\nbeta")).toBe(false);
		expect(hasLineNumbers("")).toBe(false);
	});
});

describe("isMarkitDocument (read.renderMarkdown scope)", () => {
	test("markit-convertible documents match case-insensitively", () => {
		expect(isMarkitDocument("docs/Spec.PDF")).toBe(true);
		expect(isMarkitDocument("deck.pptx")).toBe(true);
	});

	test("raw text, markdown files, and extensionless paths do not match", () => {
		expect(isMarkitDocument("README.md")).toBe(false);
		expect(isMarkitDocument("src/main")).toBe(false);
		expect(isMarkitDocument("")).toBe(false);
	});
});
