/**
 * Restart policy shared by every runtime owner: the host runtime and the
 * clone runtime watch (both in workspace-lifecycle.ts) restart a
 * crashed runtime with the same bounded, jittered exponential backoff and the
 * same crash-loop budget.
 *
 * The budget bounds crash LOOPS, not lifetime restarts: it refills only after
 * a pair has held for `stablePairMs`, so a pair-then-crash loop still exhausts
 * it. Exhaustion is the owner's cue to surface an error instead of retrying.
 */

/** A pair must hold this long before its restarts are forgiven. */
export const STABLE_PAIR_MS = 60_000;
export const DEFAULT_RESTART_MAX = 5;
export const RESTART_BACKOFF_MIN_MS = 1_000;
export const RESTART_BACKOFF_MAX_MS = 30_000;

/** Jittered exponential backoff: base = min(max, min·2^attempt), ±50%. */
export function backoffDelay(attempt: number, minMs: number, maxMs: number): number {
	const base = Math.min(maxMs, minMs * 2 ** attempt);
	return Math.round(base * (0.5 + Math.random()));
}

export interface RestartPolicy {
	/** Restarts allowed between stable pairs. */
	restartMax: number;
	backoffMinMs: number;
	backoffMaxMs: number;
	/** A pair must hold this long before the budget refills. */
	stablePairMs: number;
}

export const DEFAULT_RESTART_POLICY: RestartPolicy = {
	restartMax: DEFAULT_RESTART_MAX,
	backoffMinMs: RESTART_BACKOFF_MIN_MS,
	backoffMaxMs: RESTART_BACKOFF_MAX_MS,
	stablePairMs: STABLE_PAIR_MS,
};

/** One restart the budget granted. */
export interface RestartClaim {
	/** Zero-based restart number since the budget last refilled. */
	attempt: number;
	/** Jittered backoff to wait before relaunching. */
	delayMs: number;
}

/** Crash-loop budget for one runtime: claim restarts, refill on a stable pair. */
export class RestartBudget {
	readonly #policy: RestartPolicy;
	#restarts = 0;
	#stableTimer: Timer | null = null;

	constructor(policy: RestartPolicy) {
		this.#policy = policy;
	}

	get restartMax(): number {
		return this.#policy.restartMax;
	}

	/** Restarts claimed since the budget last refilled. */
	get used(): number {
		return this.#restarts;
	}

	/** Claim the next restart, or null when the budget is exhausted. */
	next(): RestartClaim | null {
		if (this.#restarts >= this.#policy.restartMax) return null;
		const attempt = this.#restarts++;
		return {
			attempt,
			delayMs: backoffDelay(attempt, this.#policy.backoffMinMs, this.#policy.backoffMaxMs),
		};
	}

	/** The pair came up: refill the budget if it holds for `stablePairMs`. */
	paired(): void {
		this.unpaired();
		this.#stableTimer = setTimeout(() => {
			this.#stableTimer = null;
			this.#restarts = 0;
		}, this.#policy.stablePairMs);
	}

	/** The pair dropped: it no longer counts toward the stable window. */
	unpaired(): void {
		if (this.#stableTimer === null) return;
		clearTimeout(this.#stableTimer);
		this.#stableTimer = null;
	}

	/** Cancel the pending refill timer; the budget is not reused afterwards. */
	dispose(): void {
		this.unpaired();
	}
}
