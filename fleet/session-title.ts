/**
 * Session-file reader for the fleet's git-state poll: extracts the title of
 * a daemon's last session file from its head WITHOUT parsing the whole
 * transcript, and reports whether the file holds any messages (a new/empty
 * session — untitled, rendered "New session" in the roster). Runs on a 10s
 * poll loop over N daemons, so reads are bounded to a small head chunk and
 * cached by (path, mtimeMs, size) — unchanged files cost one stat per poll,
 * exactly the HEAD_CACHE pattern of fleet/stats/routes/sessions.ts.
 *
 * File shape (ground truth: fleet/stats/routes/sessions.ts `readHead` +
 * fleet/stats/lib/jsonl.ts): line 0 is the fixed 256-byte title slot
 * `{"type":"title","title":…}`, line 1 is the session header
 * `{"type":"session",…,"title"?…}`; the title-slot title wins, the header
 * title is the fallback, and older files may lack the slot entirely (the
 * header is then line 0). Message entries are `{"type":"message",…}`
 * lines; an EMPTY session has none (persistence is lazy until assistant
 * output exists, so a fresh session's file may not exist on disk at all).
 */

import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";

/** Head chunk: the title slot is 256 B and the header line is small; a few
 *  KB covers both with slack, never pulling the transcript body. */
const HEAD_BYTES = 8 * 1024;

const HEAD_CACHE_MAX = 100;
const headCache = new Map<string, { title: string | undefined; empty: boolean }>();

function cacheKey(abs: string, mtimeMs: number, size: number): string {
	return `${abs}\u0000${mtimeMs}\u0000${size}`;
}

/** Non-empty string or undefined (mirrors sessions.ts' `str` helper). */
const str = (v: unknown): string | undefined =>
	typeof v === "string" && v.length > 0 ? v : undefined;

/** Parse one head line into its type/title slots; corrupt lines → null. */
function parseHeadLine(line: string | undefined): { type?: string; title?: unknown } | null {
	if (!line) return null;
	try {
		const o = JSON.parse(line) as unknown;
		return typeof o === "object" && o !== null ? (o as { type?: string; title?: unknown }) : null;
	} catch {
		return null; // truncated at the chunk boundary, or not JSON — skip
	}
}

/**
 * Title from the first two (possibly chunk-truncated) lines. Prefer the
 * title slot, fall back to the session-header title; older files without a
 * slot make the header the first line.
 */
function titleFromHead(chunk: string): string | undefined {
	const [raw0, raw1] = chunk.split("\n");
	const slot = parseHeadLine(raw0.trim());
	const header = parseHeadLine(raw1.trim());
	if (slot?.type === "title") {
		return str(slot.title) ?? (header ? str(header.title) : undefined);
	}
	const head = slot?.type === "session" ? slot : header?.type === "session" ? header : null;
	return head ? str(head.title) : undefined;
}

/**
 * Does the raw head text contain a message entry? A session file's entries
 * are JSON lines; a message entry is one whose object STARTS with
 * `{"type":"message"`. Matching on the line prefix is truncation-robust: a
 * huge message line cut at the head boundary still carries its first bytes,
 * and a content string containing the same text (e.g. pasted JSON) is never
 * a line start, so it cannot false-positive.
 */
function hasMessageMarker(chunk: string): boolean {
	for (const line of chunk.split("\n")) {
		if (line.trimStart().startsWith('{"type":"message"')) return true;
	}
	return false;
}

/** Cache a parsed result under (path, mtime, size), evicting LRU. */
function cacheResult(
	st: Stats,
	abs: string,
	value: { title: string | undefined; empty: boolean },
): void {
	headCache.set(cacheKey(abs, st.mtimeMs, st.size), value);
	if (headCache.size > HEAD_CACHE_MAX) {
		const oldest = headCache.keys().next().value;
		if (oldest !== undefined) headCache.delete(oldest);
	}
}

/**
 * Title and emptiness of a session file. `title` is the slot/header title or
 * undefined when the file is missing/unreadable or carries none. `empty` is
 * true when the file is missing/unreadable OR its whole contents (size ≤ the
 * head read) contain no message entry — the defining shape of a new/empty
 * session. Never throws. Results are cached by (path, mtimeMs, size) so an
 * unchanged file costs one stat; missing files are never cached, so a
 * reappearing file is re-read on the next poll.
 */
export async function readSessionInfo(path: string): Promise<{
	title: string | undefined;
	empty: boolean;
}> {
	let st: Stats;
	try {
		st = await stat(path);
	} catch {
		return { title: undefined, empty: true }; // missing/gone — never cached
	}
	if (!st.isFile()) return { title: undefined, empty: true };
	const key = cacheKey(path, st.mtimeMs, st.size);
	const hit = headCache.get(key);
	if (hit !== undefined) {
		headCache.delete(key); // refresh LRU recency
		headCache.set(key, hit);
		return hit;
	}
	let chunk: string;
	try {
		const fh = await open(path, "r");
		try {
			const buf = Buffer.alloc(HEAD_BYTES);
			const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
			chunk = buf.toString("utf8", 0, bytesRead);
		} finally {
			await fh.close();
		}
	} catch {
		return { title: undefined, empty: true }; // unreadable — never cached
	}
	const title = titleFromHead(chunk);
	// Whole file is inside the head → a message-marker miss is authoritative.
	// A larger file with no marker found in the head is treated as NOT empty
	// (safe default — never mislabel a real transcript "New session").
	const empty = st.size <= HEAD_BYTES && !hasMessageMarker(chunk);
	const value = { title, empty };
	cacheResult(st, path, value);
	return value;
}

/**
 * Title of a session file, or undefined when the file is missing/unreadable
 * or carries no title. Never throws. Reads at most HEAD_BYTES from the head
 * and parses only the first two lines; results are cached by
 * (path, mtimeMs, size) so an unchanged file costs one stat — missing files
 * are never cached, so a reappearing file is re-read on the next poll.
 */
export async function readSessionTitle(path: string): Promise<string | undefined> {
	return (await readSessionInfo(path)).title;
}
