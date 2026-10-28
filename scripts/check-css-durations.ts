import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The one file allowed to spell durations: every other stylesheet uses its motion tokens. */
const TOKENS_FILE = "apps/web/styles/tokens.css";
const timeProperty = /^(transition|animation)(-duration|-delay)?$/;
/** A CSS <time> literal; `0s`/`0ms` (e.g. visibility delays) carry no timing to drift. */
const timeLiteral = /(?<![\w-])(\d*\.?\d+)(ms|s)\b/g;

export type DurationFinding = { file: string; line: number; text: string };

/** Web stylesheets under apps/web, with comments blanked (offsets and line numbers stay exact). */
function* webStylesheets(root: string): Generator<{ path: string; source: string }> {
	for (const path of new Bun.Glob("apps/web/**/*.css").scanSync({ cwd: root })) {
		const text = readFileSync(join(root, path), "utf8");
		yield { path, source: text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " ")) };
	}
}

/** Literal durations in `transition`/`animation` declarations of web CSS outside the tokens file. */
export function checkCssDurations(root: string): DurationFinding[] {
	const findings: DurationFinding[] = [];
	for (const { path, source } of webStylesheets(root)) {
		if (path === TOKENS_FILE) continue;
		for (const decl of source.matchAll(/([\w-]+)\s*:([^;{}]*)/g)) {
			if (!timeProperty.test(decl[1]!)) continue;
			for (const time of decl[2]!.matchAll(timeLiteral)) {
				if (Number(time[1]) === 0) continue;
				const offset = decl.index! + decl[0].indexOf(":") + 1 + time.index!;
				const line = source.slice(0, offset).split("\n").length;
				findings.push({ file: path, line, text: time[0] });
			}
		}
	}
	return findings;
}

/** The at-rule and selector preludes of every block open at `offset`, outermost first. */
function openPreludes(source: string, offset: number): string[] {
	const open: string[] = [];
	let start = 0;
	for (let i = 0; i < offset; i++) {
		const c = source[i];
		if (c === "{") {
			open.push(source.slice(start, i));
			start = i + 1;
		} else if (c === "}") {
			open.pop();
			start = i + 1;
		} else if (c === ";") start = i + 1;
	}
	return open;
}

/** `infinite` animations in web CSS that are not inside `@media (prefers-reduced-motion: no-preference)`. */
export function checkCssLoops(root: string): DurationFinding[] {
	const findings: DurationFinding[] = [];
	for (const { path, source } of webStylesheets(root)) {
		for (const decl of source.matchAll(/(animation(?:-iteration-count)?)\s*:([^;{}]*)/g)) {
			if (!/(?<![\w-])infinite(?![\w-])/.test(decl[2]!)) continue;
			const offset = decl.index!;
			if (
				openPreludes(source, offset).some((p) =>
					/@media[^{]*prefers-reduced-motion\s*:\s*no-preference/.test(p),
				)
			)
				continue;
			findings.push({
				file: path,
				line: source.slice(0, offset).split("\n").length,
				text: "infinite",
			});
		}
	}
	return findings;
}

if (import.meta.main) {
	const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
	const durations = checkCssDurations(root);
	for (const f of durations) {
		console.error(
			`${relative(process.cwd(), join(root, f.file))}:${f.line}: literal duration ${f.text}; use a motion token from ${TOKENS_FILE}`,
		);
	}
	const loops = checkCssLoops(root);
	for (const f of loops) {
		console.error(
			`${relative(process.cwd(), join(root, f.file))}:${f.line}: infinite animation outside @media (prefers-reduced-motion: no-preference); loops hold still under reduced motion`,
		);
	}
	if (durations.length + loops.length > 0) process.exit(1);
}
