import type { RawEntry } from "../../../store/fleet-api";
import { entryTs } from "../../util/entries";

export type TranscriptRow =
	| { kind: "day"; ts: number; label: string }
	| { kind: "entry"; entry: RawEntry };

/**
 * Row objects remembered across rebuilds. A keyed list reuses a row's DOM only
 * while it receives the same row object, so entry rows are cached per entry and
 * day separators per timestamp.
 */
export interface RowCache {
	entries: WeakMap<RawEntry, TranscriptRow>;
	days: Map<number, TranscriptRow>;
}

export function createRowCache(): RowCache {
	return { entries: new WeakMap(), days: new Map() };
}

/**
 * Maps filtered entries to the row list, inserting a day
 * separator whenever the local calendar day changes between consecutive
 * entries. Separators are ROWS, not entries; the "N of M entries" progress line keeps
 * counting entries only. Entries without a usable timestamp never emit a
 * separator and never advance the running day. With a `cache`, an entry (or a
 * separator at the same timestamp) maps to the same row object on every call.
 */
export function buildDayRows(entries: readonly RawEntry[], cache?: RowCache): TranscriptRow[] {
	const out: TranscriptRow[] = [];
	let prevDay: string | null = null;
	for (const e of entries) {
		const ts = entryTs(e);
		if (ts !== null) {
			const day = new Date(ts).toDateString();
			// Separate only when a previous DATED row exists; undated leading rows
			// (e.g. the title slot) never produce a spurious separator.
			if (prevDay !== null && day !== prevDay) {
				let sep = cache?.days.get(ts);
				if (sep === undefined) {
					sep = { kind: "day", ts, label: new Date(ts).toLocaleDateString() };
					cache?.days.set(ts, sep);
				}
				out.push(sep);
			}
			prevDay = day;
		}
		let row = cache?.entries.get(e);
		if (row === undefined) {
			row = { kind: "entry", entry: e };
			cache?.entries.set(e, row);
		}
		out.push(row);
	}
	return out;
}
