/**
 * web_search leads its output with `Note: ...` lines whose failure reasons quote URLs; the
 * card must not list those as results.
 */
import { describe, expect, test } from "bun:test";
import { searchResultUrls, splitSearchNotes } from "../../components/chat/tools/WebSearchToolCard";

const OUTPUT = [
	"Note: answered by Exa after Brave failed (request to https://api.brave.example/search returned 429)",
	"Note: no results matched `site:docs.example`; the constraint was relaxed",
	"[1] Reconcile\n    https://docs.solidjs.com/reference/store-utilities/reconcile",
	"[2] For\n    https://docs.solidjs.com/reference/components/for",
].join("\n");

describe("splitSearchNotes", () => {
	test("splits the leading Note lines from the body", () => {
		const { notes, body } = splitSearchNotes(OUTPUT);
		expect(notes).toEqual([
			"answered by Exa after Brave failed (request to https://api.brave.example/search returned 429)",
			"no results matched `site:docs.example`; the constraint was relaxed",
		]);
		expect(body.startsWith("[1] Reconcile")).toBe(true);
	});

	test("leaves output without a leading note whole, and a later Note line in the body", () => {
		const text = "[1] A\n    https://a.example\nNote: later";
		expect(splitSearchNotes(text)).toEqual({ notes: [], body: text });
	});
});

describe("searchResultUrls", () => {
	test("lists the results, never URLs quoted in a note", () => {
		expect(searchResultUrls(OUTPUT)).toEqual([
			"https://docs.solidjs.com/reference/store-utilities/reconcile",
			"https://docs.solidjs.com/reference/components/for",
		]);
	});

	test("a note with no results yields no links", () => {
		expect(
			searchResultUrls("Note: answered by Exa after Brave failed (https://x.example)"),
		).toEqual([]);
	});
});
