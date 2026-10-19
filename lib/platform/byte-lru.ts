/**
 * Least-recently-used map bounded by the caller's byte estimate per entry
 * rather than by entry count. Count-bounded caches hold N entries no matter
 * how large each one is; here a handful of huge entries evicts many small
 * ones, and an entry above `maxEntryBytes` is never retained at all.
 *
 * One entry per key: `set` replaces the previous value, so a key whose
 * backing file changed never leaves its stale version behind. Callers keep
 * their own validity stamp (size, mtime) inside the value and treat a stamp
 * mismatch as a miss.
 */
export interface ByteLruLimits {
	/** Total bytes retained across all entries. */
	maxBytes: number;
	/** Entries costing more than this are not stored. */
	maxEntryBytes: number;
}

export class ByteLru<V> {
	readonly #limits: () => ByteLruLimits;
	readonly #entries = new Map<string, { value: V; bytes: number }>();
	#bytes = 0;

	/** `limits` is read on every `set`, so a test seam may change it between calls. */
	constructor(limits: ByteLruLimits | (() => ByteLruLimits)) {
		this.#limits = typeof limits === "function" ? limits : () => limits;
	}

	get size(): number {
		return this.#entries.size;
	}

	/** Sum of the stored entries' byte estimates. */
	get bytes(): number {
		return this.#bytes;
	}

	/** The value for `key`, refreshing its recency; undefined on a miss. */
	get(key: string): V | undefined {
		const hit = this.#entries.get(key);
		if (hit === undefined) return undefined;
		this.#entries.delete(key);
		this.#entries.set(key, hit);
		return hit.value;
	}

	/**
	 * Store `value` at an estimated `bytes` cost, evicting least recently used
	 * entries until the total fits. Returns false (and drops any previous
	 * value for the key) when the entry alone exceeds `maxEntryBytes` or
	 * `maxBytes`.
	 */
	set(key: string, value: V, bytes: number): boolean {
		this.delete(key);
		const { maxBytes, maxEntryBytes } = this.#limits();
		if (bytes > maxEntryBytes || bytes > maxBytes) return false;
		this.#entries.set(key, { value, bytes });
		this.#bytes += bytes;
		for (const [oldest, entry] of this.#entries) {
			if (this.#bytes <= maxBytes) break;
			this.#entries.delete(oldest);
			this.#bytes -= entry.bytes;
		}
		return true;
	}

	delete(key: string): void {
		const hit = this.#entries.get(key);
		if (hit === undefined) return;
		this.#entries.delete(key);
		this.#bytes -= hit.bytes;
	}

	clear(): void {
		this.#entries.clear();
		this.#bytes = 0;
	}
}
