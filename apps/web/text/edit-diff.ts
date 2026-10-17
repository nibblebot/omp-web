import { buildDiffRows, type DiffRow } from "./diff";

/** One edit call's change as diff rows, with its +/- line counts. */
export interface EditPreview {
	/** Target file from the call args (or the result details); null when unknown. */
	path: string | null;
	/** Files the change touches: 1 for replacements, the patch's file count otherwise. */
	files: number;
	rows: DiffRow[];
	added: number;
	removed: number;
}

/** One side-by-side row: `left` is the old side, `right` the new side. */
export interface SplitRow {
	left: DiffRow | null;
	right: DiffRow | null;
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

function preview(path: string | null, files: number, rows: DiffRow[]): EditPreview {
	return {
		path,
		files,
		rows,
		added: countType(rows, "add"),
		removed: countType(rows, "del"),
	};
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
		return preview(path, Math.max(files, 1), parseCompactDiff(d.diff));
	}
	return null;
}

/** Pair old/new sides for a two-column view: context on both, changes zipped. */
export function splitRows(rows: DiffRow[]): SplitRow[] {
	const out: SplitRow[] = [];
	let dels: DiffRow[] = [];
	let adds: DiffRow[] = [];
	const flush = () => {
		const n = Math.max(dels.length, adds.length);
		for (let i = 0; i < n; i++) out.push({ left: dels[i] ?? null, right: adds[i] ?? null });
		dels = [];
		adds = [];
	};
	for (const row of rows) {
		if (row.type === "del") dels.push(row);
		else if (row.type === "add") adds.push(row);
		else {
			flush();
			out.push({ left: row, right: row });
		}
	}
	flush();
	return out;
}
