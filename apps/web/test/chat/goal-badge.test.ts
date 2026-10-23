/**
 * GoalBadge narrow-layout regression test.
 *
 * The header goal badge has no DOM test harness, so this reads the shell and
 * usage stylesheets and enforces the narrow contract:
 * - below 768px the objective and budget hide, keeping the label and state
 *   (a long goal must not squeeze the header title)
 * - below 360px the whole badge hides
 * - the desktop badge truncates with an ellipsis and never wraps
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const webRoot = join(import.meta.dir, "..", "..");
const shellCss = readFileSync(join(webRoot, "styles", "shell.css"), "utf8");
const goalsCss = readFileSync(join(webRoot, "styles", "usage.css"), "utf8");

/** Concatenated bodies of every top-level `@media <query>` block in `css`. */
function mediaBodies(css: string, query: string): string {
	const head = `@media ${query} {`;
	const bodies: string[] = [];
	let at = css.indexOf(head);
	while (at !== -1) {
		const end = css.indexOf("\n}", at);
		bodies.push(css.slice(at + head.length, end));
		at = css.indexOf(head, end);
	}
	return bodies.join("\n");
}

describe("GoalBadge narrow layout", () => {
	test("below 768px the objective and budget hide, keeping the label and state", () => {
		const narrow = mediaBodies(shellCss, "(max-width: 767px)");
		expect(narrow).toMatch(
			/\.main-header \.goal-badge-objective,\s*\.main-header \.goal-badge-budget \{\s*display: none;/,
		);
	});

	test("below 360px the whole badge hides", () => {
		const tiny = mediaBodies(shellCss, "(max-width: 359px)");
		expect(tiny).toMatch(/\.main-header \.goal-badge \{\s*display: none;/);
	});

	test("the badge truncates the objective with an ellipsis and never wraps", () => {
		expect(goalsCss).toMatch(
			/\.goal-badge-objective \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s,
		);
		expect(shellCss).toMatch(
			/\.main-header \.goal-badge \{[^}]*max-width: 14rem;[^}]*text-overflow: ellipsis;/s,
		);
	});
});
