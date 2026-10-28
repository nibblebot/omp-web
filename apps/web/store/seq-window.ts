/**
 * The most recent `cap` seqs added, oldest dropped first. The replay-dedup
 * guard of the frame mux (state.ts) is one: a frame whose seq is in the window
 * was already applied. Only frames the server's replay ring keeps are ever
 * re-sent (isRingedFrameType), and the ring holds at most CLIENT_RING_CAP
 * entries, so a window of that size sees every duplicate a replay can produce
 * while memory stays constant however many frames the connection carries.
 */
export class SeqWindow {
	readonly #seqs = new Set<number>();
	/** Insertion order, as a ring: slot `#next` holds the oldest seq once full. */
	readonly #order: Float64Array;
	#next = 0;

	constructor(cap: number) {
		this.#order = new Float64Array(cap);
	}

	get size(): number {
		return this.#seqs.size;
	}

	has(seq: number): boolean {
		return this.#seqs.has(seq);
	}

	add(seq: number): void {
		if (this.#seqs.has(seq)) return;
		if (this.#seqs.size === this.#order.length) this.#seqs.delete(this.#order[this.#next]);
		this.#order[this.#next] = seq;
		this.#next = (this.#next + 1) % this.#order.length;
		this.#seqs.add(seq);
	}

	clear(): void {
		this.#seqs.clear();
		this.#next = 0;
	}
}
