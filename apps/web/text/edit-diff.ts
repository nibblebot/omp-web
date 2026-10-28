import { buildDiffRows, type DiffRow } from "./diff";

/** One file's slice of a change: its rows are highlighted as one contiguous source per side. */
export interface DiffFile {
	/** File path (picks the highlight grammar); null when unknown. */
	path: string | null;
	rows: DiffRow[];
}

/** One edit call's change as diff rows, with its +/- line counts. */
export interface EditPreview {
	/** Target file from the call args (or the result details); null when unknown. */
	path: string | null;
	/** Files the change touches: 1 for replacements, the patch's file count otherwise. */
	files: number;
	/** All rows, in order. */
	rows: DiffRow[];
	/** `rows` split per file; a single entry unless per-file results describe the same rows. */
	sections: DiffFile[];
	added: number;
	removed: number;
}

type Record_ = Record<string, unknown>;

function asRecord(value: unknown): Record_ | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record_) : null;
}

interface ReplacePair {
	oldText: string;
	newText: string;
}

/** A replacement pair in the SDK schema (`old_string`/`new_string`) or legacy (`oldText`/`newText`). */
function pairOf(value: unknown): ReplacePair | null {
	const r = asRecord(value);
	if (!r) return null;
	const oldText = typeof r.old_string === "string" ? r.old_string : r.oldText;
	const newText = typeof r.new_string === "string" ? r.new_string : r.newText;
	return typeof oldText === "string" && typeof newText === "string" ? { oldText, newText } : null;
}

/** Replacement pairs from `edits[]` (batch) or the top-level pair; partially streamed entries drop out. */
function replacePairs(r: Record_): ReplacePair[] {
	const list = Array.isArray(r.edits) ? r.edits : [r];
	return list.map(pairOf).filter((p): p is ReplacePair => p !== null);
}

/** Compact hashline/patch diff rows: `+12|text`, `-12|text`, ` 12|text`; elisions are skipped. */
const COMPACT_LINE = /^([+ -])\s*\d+\|(.*)$/;

function parseCompactDiff(diff: string): DiffRow[] {
	const rows: DiffRow[] = [];
	for (const line of diff.split("\n")) {
		const m = COMPACT_LINE.exec(line);
		if (!m) continue;
		const type = m[1] === "+" ? "add" : m[1] === "-" ? "del" : "context";
		rows.push({ type, text: m[2] ?? "" });
	}
	return rows;
}

function countType(rows: DiffRow[], type: "add" | "del"): number {
	let n = 0;
	for (const row of rows) if (row.type === type) n++;
	return n;
}

function preview(
	path: string | null,
	files: number,
	rows: DiffRow[],
	sections: DiffFile[] = [{ path, rows }],
): EditPreview {
	return {
		path,
		files,
		rows,
		sections,
		added: countType(rows, "add"),
		removed: countType(rows, "del"),
	};
}

/** The first `limit` rows across `sections`, in order; sections the cap cuts keep a new, shorter `rows`. */
export function capDiffSections(sections: readonly DiffFile[], limit: number): DiffFile[] {
	let left = limit;
	const out: DiffFile[] = [];
	for (const file of sections) {
		if (left <= 0) break;
		const rows = file.rows.length <= left ? file.rows : file.rows.slice(0, left);
		left -= rows.length;
		out.push(rows === file.rows ? file : { path: file.path, rows });
	}
	return out;
}

/** The header numbers of a change: what {@link EditPreview} carries without its rows. */
export type EditStats = Pick<EditPreview, "path" | "files" | "added" | "removed">;

/** Count of lines (text ending without a newline still counts) in `text`. */
function lineCount(text: string): number {
	if (text === "") return 0;
	let n = 1;
	for (let i = text.indexOf("\n"); i !== -1 && i < text.length - 1; i = text.indexOf("\n", i + 1))
		n++;
	return n;
}

/**
 * The stats {@link editPreview} would report, for the calls whose rows are not
 * needed to know them: a `write` (every line is added) and a result that carries
 * the compact diff. Undefined for replacements, which need the line diff, and
 * for anything not renderable yet; the caller then asks {@link editPreview}.
 */
export function cheapEditStats(
	name: string,
	args: unknown,
	details?: unknown,
): EditStats | undefined {
	const r = asRecord(args);
	const d = asRecord(details);
	const argPath = typeof r?.path === "string" ? r.path : undefined;
	const detailPath = typeof d?.path === "string" ? d.path : undefined;
	const path = argPath ?? detailPath ?? null;
	if (name === "write") {
		if (!r || typeof r.content !== "string") return undefined;
		return { path, files: 1, added: lineCount(r.content), removed: 0 };
	}
	if (r && argPath !== undefined && replacePairs(r).length > 0) return undefined;
	if (typeof d?.diff !== "string") return undefined;
	let added = 0;
	let removed = 0;
	for (const line of d.diff.split("\n")) {
		const m = COMPACT_LINE.exec(line);
		if (m?.[1] === "+") added++;
		else if (m?.[1] === "-") removed++;
	}
	const files = Array.isArray(d.perFileResults) ? d.perFileResults.length : 1;
	return { path, files: Math.max(files, 1), added, removed };
}

/**
 * Per-file sections from `details.perFileResults` (each `{ path, diff }`), only
 * when they cover exactly the combined `rows`; otherwise undefined (one section).
 */
function perFileSections(results: unknown, rows: DiffRow[]): DiffFile[] | undefined {
	if (!Array.isArray(results) || results.length < 2) return undefined;
	const sections: DiffFile[] = [];
	let total = 0;
	for (const entry of results) {
		const r = asRecord(entry);
		if (typeof r?.path !== "string" || typeof r.diff !== "string") return undefined;
		const own = parseCompactDiff(r.diff);
		total += own.length;
		sections.push({ path: r.path, rows: own });
	}
	return total === rows.length ? sections : undefined;
}

/**
 * Per-row highlighted HTML for one file's rows, or null when `highlight`
 * declines (no grammar yet). Each side is highlighted as contiguous text so
 * multi-line comments and strings color across rows: the old side is the
 * context+del rows, the new side the context+add rows. Del rows take the old
 * side's line, add and context rows the new side's. Collapse rows are null.
 */
export function highlightDiffRows(
	rows: DiffRow[],
	highlight: (code: string) => string[] | null,
): Array<string | null> | null {
	const oldText: string[] = [];
	const newText: string[] = [];
	for (const row of rows) {
		if (row.type === "collapse") continue;
		if (row.type !== "add") oldText.push(row.text);
		if (row.type !== "del") newText.push(row.text);
	}
	const side = (lines: string[]): string[] | null | undefined =>
		lines.length === 0 ? [] : highlight(lines.join("\n"));
	const oldHtml = side(oldText);
	const newHtml = side(newText);
	if (!oldHtml || !newHtml) return null;
	if (oldHtml.length !== oldText.length || newHtml.length !== newText.length) return null;
	let o = 0;
	let n = 0;
	return rows.map((row) => {
		if (row.type === "collapse") return null;
		if (row.type === "del") return oldHtml[o++] ?? null;
		if (row.type === "add") return newHtml[n++] ?? null;
		o++;
		return newHtml[n++] ?? null;
	});
}

/**
 * Derive the diff for an edit/write/patch tool call. Works on partial args
 * (streaming) and on details-only results. Returns null when nothing is
 * renderable yet, so the card shows a neutral placeholder, never raw args.
 */
export function editPreview(name: string, args: unknown, details?: unknown): EditPreview | null {
	const r = asRecord(args);
	const d = asRecord(details);
	const argPath = typeof r?.path === "string" ? r.path : undefined;
	const detailPath = typeof d?.path === "string" ? d.path : undefined;
	const path = argPath ?? detailPath ?? null;

	if (name === "write") {
		if (!r || typeof r.content !== "string") return null;
		return preview(path, 1, buildDiffRows("", r.content));
	}

	if (r && argPath !== undefined) {
		const pairs = replacePairs(r);
		if (pairs.length > 0) {
			const rows = pairs.flatMap((p) => buildDiffRows(p.oldText, p.newText));
			return preview(path, 1, rows);
		}
	}

	if (typeof d?.diff === "string") {
		const files = Array.isArray(d.perFileResults) ? d.perFileResults.length : 1;
		const rows = parseCompactDiff(d.diff);
		return preview(path, Math.max(files, 1), rows, perFileSections(d.perFileResults, rows));
	}
	return null;
}
