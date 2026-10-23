/**
 * `N:` (hashline) / `N|` (plain line numbers) / `N→` prefix the SDK adds to
 * numbered read output; capture 1 is the line number. Nothing after the
 * separator belongs to the prefix: the rest is the line verbatim, indent included.
 */
export const LINE_NUMBER = /^\s*(\d+)\s*[→|:]/;

/**
 * Whether the read output carries SDK line numbers: a majority of non-empty
 * lines match `LINE_NUMBER`. Hashline edit mode always numbers; otherwise
 * numbering follows `readLineNumbers`.
 */
export function hasLineNumbers(output: string): boolean {
	const lines = output.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return false;
	const matched = lines.filter((line) => LINE_NUMBER.test(line)).length;
	return matched / lines.length > 0.6;
}

/**
 * Extensions the SDK converts to Markdown with markit (SDK utils/markit.ts:22).
 * Copied because the web cannot import SDK modules.
 */
const MARKIT_EXTENSIONS: Record<string, true> = {
	".pdf": true,
	".docx": true,
	".pptx": true,
	".xlsx": true,
	".epub": true,
};

/** Whether `path` is a document the SDK converts to Markdown (read.ts:2051). */
export function isMarkitDocument(path: string): boolean {
	const dot = path.lastIndexOf(".");
	if (dot < 0) return false;
	return MARKIT_EXTENSIONS[path.slice(dot).toLowerCase()] === true;
}

/** Hashline file header the SDK prepends to numbered reads: `[path#TAG]`. */
const HASHLINE_HEADER = /^\[.+#[0-9a-z]+\]$/i;
/** Trailing read notices: `[N more lines in file. Use :M to continue]`, `[Showing line N (partial, ...)]`. */
const READ_NOTICE = /^\[(?:\d+ more lines in (?:file|listing)\b|Showing line \d+ \(partial)/;

/** One displayed row of a read result. */
export interface ReadRow {
	/** File line number; null for notices and elision rows (no gutter number). */
	no: number | null;
	/** Row text without any SDK prefix. */
	text: string;
	/** True for file content (highlighted); false for notices and elision rows. */
	code: boolean;
}

/**
 * Split read output into rows: drops the hashline header (the card header
 * already names the path), strips `N:`/`N|` prefixes keeping the SDK's own line
 * numbers (they jump where bracket context elides lines), and marks trailing
 * notices and unnumbered gaps as non-code. `offset` numbers plain output.
 */
export function parseReadOutput(
	output: string,
	offset: number,
): { numbered: boolean; rows: ReadRow[] } {
	const lines = output.split("\n");
	if (lines.length > 0 && HASHLINE_HEADER.test(lines[0])) lines.shift();
	const body = lines.join("\n");
	const numbered = hasLineNumbers(body);
	const rows: ReadRow[] = [];
	let next = offset;
	let inNotice = false;
	for (const line of lines) {
		if (!inNotice && READ_NOTICE.test(line)) inNotice = true;
		if (inNotice) {
			rows.push({ no: null, text: line, code: false });
			continue;
		}
		if (numbered) {
			const m = LINE_NUMBER.exec(line);
			if (m) {
				rows.push({ no: Number(m[1]), text: line.slice(m[0].length), code: true });
			} else {
				rows.push({ no: null, text: line, code: false });
			}
		} else {
			rows.push({ no: next++, text: line, code: true });
		}
	}
	// A trailing newline leaves one empty row; blank separators before a notice stay.
	// (A numbered blank row is a real blank file line and stays.)
	while (rows.length > 0) {
		const last = rows[rows.length - 1];
		if (last.text !== "" || (numbered && last.no !== null)) break;
		rows.pop();
	}
	return { numbered, rows };
}
