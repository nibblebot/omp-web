/**
 * Regression for the composer status row at 390px: the preset chip must shrink
 * and ellipsize instead of spilling into the thinking chip, and the row must fit
 * the column so the cost segment is not clipped. Pinned against the shipped CSS
 * because bun tests have no layout engine.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const appCss = readFileSync(join(import.meta.dir, "..", "styles", "app.css"), "utf8");

/** Every `@media (<query>) { ... }` block body, brace-matched. */
function mediaBlocks(css: string, query: string): string[] {
	const blocks: string[] = [];
	const marker = `@media (${query}) {`;
	let start = css.indexOf(marker);
	while (start >= 0) {
		let depth = 0;
		for (let i = css.indexOf("{", start); i < css.length; i++) {
			if (css[i] === "{") depth++;
			if (css[i] === "}") {
				depth--;
				if (depth === 0) {
					blocks.push(css.slice(start, i + 1));
					break;
				}
			}
		}
		start = css.indexOf(marker, start + marker.length);
	}
	return blocks;
}

const narrow = mediaBlocks(appCss, "max-width: 767px").find((b) => b.includes(".session-bar {"));

describe("composer status row at narrow widths (U05)", () => {
	test("the narrow session-bar block exists", () => {
		expect(narrow).toBeDefined();
	});

	test("the preset chip shrinks and ellipsizes rather than spilling", () => {
		expect(narrow).toMatch(
			/\.preset-segment\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*\}/,
		);
	});

	test("the thinking chip and cost segment keep their natural width", () => {
		expect(narrow).toMatch(/\.session-bar > \.thinking-segment,\s*\.session-bar > \.stats-segment\s*\{\s*flex:\s*none;\s*\}/);
	});

	test("the ctx text prefix drops so the row fits the column", () => {
		expect(narrow).toMatch(/\.session-bar \.context-prefix\s*\{\s*display:\s*none;\s*\}/);
	});
});
