/**
 * Header facts from the head of a stored session JSONL: the title slot
 * (line 1), the session header (line 1 or 2), and first/last entry
 * timestamps. Callers pass only a byte prefix (SESSION_HEAD_BYTES), so a
 * listing never reads a whole transcript to answer header questions.
 */
import type { RawEntry } from "#lib/wire/stats-types";
import { parseLine } from "./stats-jsonl";

/** Bytes read from the start of a transcript to answer header questions. */
export const SESSION_HEAD_BYTES = 64 * 1024;

/** Header facts parsed from a transcript head. */
export interface SessionHead {
	title: string | null;
	cwd: string | null;
	id: string | null;
	firstTs: number | null;
	lastTs: number | null;
}

/** A non-empty string, or null: an empty title counts as absent. */
function nonEmpty(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/** Parse the head text of a session JSONL. Pure: never reads files. */
export function parseSessionHead(text: string): SessionHead {
	const entries: RawEntry[] = [];
	for (const line of text.split("\n").slice(0, 4)) {
		const e = parseLine(line);
		if (e) entries.push(e);
	}
	const first = entries[0];
	const second = entries[1];
	const head = first?.type === "session" ? first : second?.type === "session" ? second : undefined;
	const slotTitle = first?.type === "title" ? nonEmpty(first.title) : null;
	const title = slotTitle ?? (head ? nonEmpty(head.title) : null);
	const cwd = head && typeof head.cwd === "string" ? head.cwd : null;
	const id = head && typeof head.id === "string" ? head.id : null;
	let firstTs: number | null = null;
	let lastTs: number | null = null;
	for (const e of entries) {
		if (typeof e.timestamp === "number") {
			if (firstTs === null) firstTs = e.timestamp;
			lastTs = e.timestamp;
		}
	}
	return { title, cwd, id, firstTs, lastTs };
}
