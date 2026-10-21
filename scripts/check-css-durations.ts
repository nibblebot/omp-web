import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** The one file allowed to spell durations: every other stylesheet uses its motion tokens. */
const TOKENS_FILE = "apps/web/styles/tokens.css";
const timeProperty = /^(transition|animation)(-duration|-delay)?$/;
/** A CSS <time> literal; `0s`/`0ms` (e.g. visibility delays) carry no timing to drift. */
const timeLiteral = /(?<![\w-])(\d*\.?\d+)(ms|s)\b/g;

export type DurationFinding = { file: string; line: number; text: string };

/** Literal durations in `transition`/`animation` declarations of web CSS outside the tokens file. */
export function checkCssDurations(root: string): DurationFinding[] {
	const findings: DurationFinding[] = [];
	for (const path of new Bun.Glob("apps/web/**/*.css").scanSync({ cwd: root })) {
		if (path === TOKENS_FILE) continue;
		const text = readFileSync(join(root, path), "utf8");
		// Blank comments but keep offsets, so line numbers stay exact.
		const source = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
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

if (import.meta.main) {
	const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
	const findings = checkCssDurations(root);
	for (const f of findings) {
		console.error(
			`${relative(process.cwd(), join(root, f.file))}:${f.line}: literal duration ${f.text}; use a motion token from ${TOKENS_FILE}`,
		);
	}
	if (findings.length > 0) process.exit(1);
}
