/**
 * Regression for the 390px header goal badge (REV-09, U21): the compact header
 * must keep the badge's objective and budget out of the row so the title is not
 * squeezed, and the badge must hide below 360px. Pinned against the shipped CSS
 * because bun tests have no layout engine.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const shellCss = readFileSync(join(import.meta.dir, "..", "styles", "shell.css"), "utf8");

/** The body of the first `@media (<query>) { ... }` block, brace-matched. */
function mediaBlock(css: string, query: string): string {
	const start = css.indexOf(`@media (${query}) {`);
	if (start < 0) throw new Error(`no @media (${query}) block in shell.css`);
	let depth = 0;
	for (let i = css.indexOf("{", start); i < css.length; i++) {
		if (css[i] === "{") depth++;
		if (css[i] === "}") {
			depth--;
			if (depth === 0) return css.slice(start, i + 1);
		}
	}
	throw new Error(`unterminated @media (${query}) block`);
}

describe("header goal badge at narrow widths (U21, REV-09)", () => {
	test("below 768px the objective and budget are hidden in the main header", () => {
		const block = mediaBlock(shellCss, "max-width: 767px");
		expect(block).toMatch(
			/\.main-header \.goal-badge-objective,\s*\.main-header \.goal-badge-budget\s*\{\s*display:\s*none;\s*\}/,
		);
	});

	test("below 360px the goal badge itself is hidden", () => {
		const block = mediaBlock(shellCss, "max-width: 359px");
		expect(block).toMatch(/\.main-header \.goal-badge\s*\{\s*display:\s*none;\s*\}/);
	});

	test("the badge keeps a truncating max-width so the title keeps its room", () => {
		expect(shellCss).toMatch(/\.main-header \.goal-badge\s*\{[^}]*max-width:\s*14rem;/);
		expect(mediaBlock(shellCss, "max-width: 767px")).toMatch(
			/\.main-header \.goal-badge\s*\{\s*max-width:\s*9rem;\s*\}/,
		);
	});
});
