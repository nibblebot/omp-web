import { CLIENT_RING_BYTES } from "./protocol";

/**
 * Bounded replay ring of recent deltas. The server stamps each delta with a
 * monotonic seq (≥ DELTA_SEQ_START) and keeps the last `cap` entries so a
 * reconnecting consumer can resume after the last seq it saw.
 *
 * Bounds are byte-first, entry-count second: `maxBytes` (default
 * CLIENT_RING_BYTES) evicts from the head so a few multi-megabyte deltas cannot
 * balloon memory even far below `cap` (finding #5); the entry cap remains as
 * a secondary bound for many-small-delta bursts. Sizes are the stored
 * values' UTF-8 byte lengths, which is what the budget protects. A single
 * entry larger than the whole budget still lands (the newest delta is the one
 * consumer needs most, and `cap` still bounds the count). Eviction is from
 * the head only, so `after()` stays correct: a resumed consumer simply sees
 * older entries missing, which callers treat as re-derivable (drop-and-
 * resume), never as a corrupted tail.
 */
export class ReplayRing<T = unknown> {
	readonly #cap: number;
	readonly #maxBytes: number;
	#entries: Array<{ seq: number; value: T; bytes: number }> = [];
	#bytes = 0;

	constructor(cap: number, maxBytes?: number) {
		this.#cap = cap;
		this.#maxBytes = maxBytes ?? CLIENT_RING_BYTES;
	}

	get size(): number {
		return this.#entries.length;
	}

	/** Total UTF-8 byte size of the ringed string values (0 for non-strings). */
	get bytes(): number {
		return this.#bytes;
	}

	push(seq: number, value: T): void {
		const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
		this.#entries.push({ seq, value, bytes });
		this.#bytes += bytes;
		// Byte budget first: evict from the head while over budget. The
		// newest entry is never evicted (a single frame larger than the whole
		// budget still lands); `drop` counts from the head so one splice does
		// all the work.
		let drop = 0;
		while (drop < this.#entries.length - 1 && this.#bytes > this.#maxBytes) {
			this.#bytes -= this.#entries[drop].bytes;
			drop++;
		}
		// Entry cap second (secondary bound for many-small-delta bursts).
		if (this.#entries.length - drop > this.#cap) {
			const capDrop = this.#entries.length - drop - this.#cap;
			for (let i = 0; i < capDrop; i++) this.#bytes -= this.#entries[drop + i].bytes;
			drop += capDrop;
		}
		if (drop > 0) this.#entries.splice(0, drop);
	}

	/** Entries with seq > `after`, oldest first. */
	after(after: number): Array<{ seq: number; value: T }> {
		let lo = 0;
		let hi = this.#entries.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.#entries[mid].seq <= after) lo = mid + 1;
			else hi = mid;
		}
		return this.#entries.slice(lo);
	}
}
