/**
 * `omp-web theme check <file>` validates one theme file through the same
 * parse / migrate / derive / contrast path the control plane uses for
 * `<config dir>/themes/*.json` (lib/themes/parse.ts), without installing it.
 *
 * Exit codes: 0 = valid (warnings are informational), 1 = schema errors
 * (including a non-.json file name, a bad stem, or invalid JSON), 2 = usage
 * error or unreadable file. Results go to stdout, errors and diagnostics to
 * stderr with an `omp-web:` prefix on the usage/read failures.
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { contrastWarnings } from "#lib/themes/contrast";
import { parseThemeFile } from "#lib/themes/parse";
import { THEME_SCHEMES, THEME_TOKENS } from "#lib/themes/types";
import type { ThemeContrastWarning } from "#lib/themes/types";

export const THEME_USAGE = `usage: omp-web theme check <file>

  check <file>                 validate a theme file (<stem>.json): prints schema
                               errors, contrast warnings and resolved tokens per
                               variant; exit 1 on schema errors, 2 on usage or
                               unreadable file`;

/** Sink for command output; defaults to the console. */
export interface ThemeCheckIO {
	out: (line: string) => void;
	err: (line: string) => void;
}

const consoleIO: ThemeCheckIO = {
	out: (line) => console.log(line),
	err: (line) => console.error(line),
};

function describeWarning(warning: ThemeContrastWarning): string {
	if (warning.kind === "contrast") {
		return `${warning.fg} on ${warning.bg}: ${warning.ratio.toFixed(2)}:1 (min ${warning.min}:1)`;
	}
	return `${warning.token}: ${warning.reason}`;
}

export async function main(argv: string[], io: ThemeCheckIO = consoleIO): Promise<number> {
	const [sub, file, ...rest] = argv;
	if (sub !== "check") {
		io.err(`${THEME_USAGE}${sub === undefined ? "" : `\nomp-web: unknown theme command: ${sub}`}`);
		return 2;
	}
	if (file === undefined || file === "" || rest.length > 0) {
		io.err(`${THEME_USAGE}\nomp-web: theme check takes exactly one file`);
		return 2;
	}

	let text: string;
	try {
		text = await readFile(file, "utf8");
	} catch (e) {
		io.err(`omp-web: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
		return 2;
	}

	const fileName = basename(file);
	if (extname(fileName) !== ".json") {
		io.err(`error: ${fileName}: theme files must be named <stem>.json`);
		return 1;
	}
	const stem = basename(fileName, ".json");

	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (e) {
		io.err(`error: ${fileName}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
		return 1;
	}

	const result = parseThemeFile(stem, raw, "custom");
	if (!result.ok) {
		for (const error of result.errors) io.err(`error: ${error}`);
		io.err(`${fileName}: ${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`);
		return 1;
	}

	const { entry } = result;
	io.out(`${entry.name} (${entry.id})`);
	for (const scheme of THEME_SCHEMES) {
		const variant = entry.variants[scheme];
		if (variant === undefined) continue;
		io.out("");
		io.out(`${scheme} variant`);
		const warnings = contrastWarnings(variant.tokens, scheme);
		if (warnings.length === 0) {
			io.out("  warnings: none");
		} else {
			io.out(`  warnings (${warnings.length}):`);
			for (const warning of warnings) io.out(`    ${describeWarning(warning)}`);
		}
		io.out("  tokens:");
		for (const token of THEME_TOKENS) io.out(`    --${token}: ${variant.tokens[token]}`);
	}
	return 0;
}
