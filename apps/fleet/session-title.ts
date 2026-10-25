/**
 * Session-file reader for the fleet's git-state poll: extracts the title of
 * a session's last session file from its head WITHOUT parsing the whole
 * transcript, and reports whether the file holds any messages (a new/empty
 * session, untitled and rendered "New session" in the roster). Runs on a 10s
 * poll loop over N sessions, so reads are bounded to a small head chunk and
 * cached by (path, mtimeMs, size); unchanged files cost one stat per poll,
 * exactly the head-cache pattern of stats-sessions.ts `readHead`.
 *
 * File shape (transcript format read by stats-jsonl.ts): line 0 is the fixed 256-byte title slot
 * `{"type":"title","title":…}`, line 1 is the session header
 * `{"type":"session",…,"title"?…}`; the title-slot title wins, the header
 * title is the fallback, and older files may lack the slot entirely (the
 * header is then line 0). Message entries are `{"type":"message",…}`
 * lines; an EMPTY session has none (persistence is lazy until assistant
 * output exists, so a fresh session's file may not exist on disk at all).
 */

import type { Stats } from "node:fs";
import { open, stat } from "node:fs/promises";
import { ByteLru } from "#lib/platform/byte-lru";
import { parseSessionHead } from "./session-head";

/** Head chunk: the title slot is 256 B and the header line is small; a few
 *  KB covers both with slack, never pulling the transcript body. */
const HEAD_BYTES = 8 * 1024;

/**
 * Head results are a few hundred bytes each, so the budget is in bytes: a
 * count cap (the old 100 entries) thrashed on any poll touching more files
 * than the cap, re-reading every head on every pass.
 */
const HEAD_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const HEAD_CACHE_MAX_ENTRY_BYTES = 64 * 1024;
const headCache = new ByteLru<{ title: string | undefined; empty: boolean }>({
	maxBytes: HEAD_CACHE_MAX_BYTES,
	maxEntryBytes: HEAD_CACHE_MAX_ENTRY_BYTES,
});

function cacheKey(abs: string, mtimeMs: number, size: number): string {
	return `${abs}\u0000${mtimeMs}\u0000${size}`;
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

/** Cache a parsed result under (path, mtime, size); cost is path + title length + fixed overhead. */
function cacheResult(
	st: Stats,
	abs: string,
	value: { title: string | undefined; empty: boolean },
): void {
	const cost = abs.length + (value.title?.length ?? 0) + 64;
	headCache.set(cacheKey(abs, st.mtimeMs, st.size), value, cost);
}

/**
 * Title and emptiness of a session file. `title` is the slot/header title or
 * undefined when the file is missing/unreadable or carries none. `empty` is
 * true when the file is missing/unreadable OR its whole contents (size ≤ the
 * head read) contain no message entry, the defining shape of a new/empty
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
		return { title: undefined, empty: true }; // missing/gone, never cached
	}
	if (!st.isFile()) return { title: undefined, empty: true };
	const key = cacheKey(path, st.mtimeMs, st.size);
	const hit = headCache.get(key);
	if (hit !== undefined) return hit;
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
		return { title: undefined, empty: true }; // unreadable, never cached
	}
	const title = parseSessionHead(chunk).title ?? undefined;
	// Whole file is inside the head → a message-marker miss is authoritative.
	// A larger file with no marker found in the head is treated as NOT empty
	// (safe default, never mislabel a real transcript "New session").
	const empty = st.size <= HEAD_BYTES && !hasMessageMarker(chunk);
	const value = { title, empty };
	cacheResult(st, path, value);
	return value;
}

/**
 * Title of a session file, or undefined when the file is missing/unreadable
 * or carries no title. Never throws. Reads at most HEAD_BYTES from the head
 * and parses the head with the shared parseSessionHead; results are cached by
 * (path, mtimeMs, size) so an unchanged file costs one stat; missing files
 * are never cached, so a reappearing file is re-read on the next poll.
 */
export async function readSessionTitle(path: string): Promise<string | undefined> {
	return (await readSessionInfo(path)).title;
}
