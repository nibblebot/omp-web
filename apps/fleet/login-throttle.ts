/**
 * Per-client login backoff for POST /auth/login (FEDGE-11). The access token
 * is a single operator secret, so an unthrottled online guess loop is the
 * threat. Failures are counted per resolved client address; the first few
 * are free (typos), then each further failure locks that client out for an
 * exponentially growing window capped at MAX_LOCK_MS. A success clears the
 * client's record, and a quiet FORGET_AFTER_MS resets the count. The table is
 * bounded: the least recently failing client is dropped first.
 */

const FREE_FAILURES = 5;
const BASE_LOCK_MS = 1_000;
const MAX_LOCK_MS = 5 * 60_000;
const FORGET_AFTER_MS = 15 * 60_000;
const MAX_TRACKED = 4_096;

interface Strikes {
	failures: number;
	lastFailure: number;
	lockedUntil: number;
}

export class LoginThrottle {
	readonly #strikes = new Map<string, Strikes>();
	readonly #now: () => number;

	constructor(opts: { now?: () => number } = {}) {
		this.#now = opts.now ?? Date.now;
	}

	/** Milliseconds until `client` may attempt a login again; 0 = now. */
	retryAfterMs(client: string): number {
		const strikes = this.#strikes.get(client);
		if (strikes === undefined) return 0;
		const now = this.#now();
		if (now - strikes.lastFailure > FORGET_AFTER_MS) {
			this.#strikes.delete(client);
			return 0;
		}
		return Math.max(0, strikes.lockedUntil - now);
	}

	recordFailure(client: string): void {
		const now = this.#now();
		const prev = this.#strikes.get(client);
		const live = prev !== undefined && now - prev.lastFailure <= FORGET_AFTER_MS;
		const failures = (live ? prev.failures : 0) + 1;
		const lockMs =
			failures <= FREE_FAILURES
				? 0
				: Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (failures - FREE_FAILURES - 1));
		// Delete first so re-insertion moves the client to the back of the LRU order.
		this.#strikes.delete(client);
		this.#strikes.set(client, { failures, lastFailure: now, lockedUntil: now + lockMs });
		if (this.#strikes.size > MAX_TRACKED) {
			const oldest = this.#strikes.keys().next().value;
			if (oldest !== undefined) this.#strikes.delete(oldest);
		}
	}

	recordSuccess(client: string): void {
		this.#strikes.delete(client);
	}
}
