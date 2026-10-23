/**
 * Parser for the SDK grep tool's text output (pi-coding-agent tools/grep.ts and
 * pi-tui tools/grouped-file-output.ts, match-line-format.ts). Shapes handled:
 *
 * - Grouped (a directory or several paths): `# dir/` and `## file.ts#TAG`
 *   headers nested one `#` per level, the shared prefix folded into the top
 *   header; blank lines separate groups.
 * - Flat (one file): an optional `[path#TAG]` header, then match rows.
 * - Match rows: `*12:text` (hashline mode) or `*12|text` (plain), context rows
 *   with a space marker instead of `*`; the display form `*12│text` is accepted too.
 * - `...` (or `│...`) between non-adjacent context runs.
 * - Anything else (limit/warning notes, "No matches") stays a text row.
 */

export type SearchRow =
	| { kind: "file"; path: string }
	| {
			kind: "line";
			/** Full path of the owning file, when known. */
			path: string | undefined;
			no: number;
			mark: boolean;
			text: string;
			/** Column of the first match, when the SDK appended ` [col N]` to a cut line. */
			col: number | undefined;
	  }
	| { kind: "gap" }
	| { kind: "text"; text: string };

const GROUP_HEADER = /^(#+) (.*)$/;
const FLAT_HEADER = /^\[(.+)#[0-9a-z]+\]$/i;
const HEADER_TAG = /#[0-9a-f]+$/i;
const HEADER_SUFFIX = /\s+\([^)]*\)\s*$/;
const MATCH_LINE = /^([ *]?)(\d+)[:|│](.*)$/;
const GAP_LINE = /^\s*(?:│)?\.\.\.$/;
const COLUMN_SUFFIX = / \[col (\d+)\]$/;

/** Parse grep output; `fallbackPath` owns rows that precede any header (single-file scope). */
export function parseGrepOutput(output: string, fallbackPath?: string): SearchRow[] {
	const rows: SearchRow[] = [];
	const dirs: string[] = [];
	let current = fallbackPath;
	for (const line of output.split("\n")) {
		if (line.length === 0) continue;
		const group = GROUP_HEADER.exec(line);
		if (group) {
			const depth = group[1].length;
			const rest = group[2].trimEnd();
			dirs.length = Math.min(dirs.length, depth - 1);
			if (rest.endsWith("/")) {
				dirs[depth - 1] = rest.slice(0, -1).replace(HEADER_SUFFIX, "");
				continue;
			}
			const name = rest.replace(HEADER_SUFFIX, "").replace(HEADER_TAG, "");
			current = [...dirs.filter(Boolean), name].join("/");
			rows.push({ kind: "file", path: current });
			continue;
		}
		const flat = FLAT_HEADER.exec(line);
		if (flat) {
			current = flat[1];
			rows.push({ kind: "file", path: current });
			continue;
		}
		const match = MATCH_LINE.exec(line);
		if (match) {
			let text = match[3];
			let col: number | undefined;
			const cut = match[1] === "*" ? COLUMN_SUFFIX.exec(text) : null;
			if (cut) {
				col = Number(cut[1]);
				text = text.slice(0, cut.index);
			}
			rows.push({
				kind: "line",
				path: current,
				no: Number(match[2]),
				mark: match[1] === "*",
				text,
				col,
			});
			continue;
		}
		if (GAP_LINE.test(line)) {
			rows.push({ kind: "gap" });
			continue;
		}
		rows.push({ kind: "text", text: line });
	}
	return rows;
}
