/**
 * Event-loop lag probe for the harness process. The synthetic client stamps a
 * frame's receive time when its chunk is read on this process's one JS thread,
 * so any blocking work here (a large JSON.parse, a burst of frame handling)
 * delays the stamp and shows up as fake stream latency. The probe ticks every
 * millisecond; a tick that arrives late by `lag` ms means the loop was blocked
 * for about that long. It is part of every measured window (see measure.ts) so
 * a harness artifact cannot masquerade as transport latency again.
 */
import { monotonicNs } from "./clock";

const TICK_MS = 1;
/** Lag above this counts as a stall. */
export const STALL_MS = 5;

export interface LagStats {
	ticks: number;
	p50: number;
	p99: number;
	max: number;
	/** Ticks that arrived more than STALL_MS late. */
	stalls: number;
}

/** Event-loop lag of this process, sampled by a 1 ms timer between `start` and `stop`. */
export class LoopLagProbe {
	#lags: number[] = [];
	#timer: NodeJS.Timeout | undefined;
	#last = 0n;

	start(): void {
		this.#last = monotonicNs();
		this.#timer = setInterval(() => {
			const now = monotonicNs();
			this.#lags.push(Math.max(0, Number(now - this.#last) / 1e6 - TICK_MS));
			this.#last = now;
		}, TICK_MS);
		this.#timer.unref();
	}

	stop(): LagStats {
		if (this.#timer !== undefined) clearInterval(this.#timer);
		this.#timer = undefined;
		const sorted = [...this.#lags].sort((a, b) => a - b);
		const at = (p: number): number =>
			sorted.length === 0
				? 0
				: sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
		return {
			ticks: sorted.length,
			p50: at(50),
			p99: at(99),
			max: sorted.at(-1) ?? 0,
			stalls: sorted.filter((l) => l > STALL_MS).length,
		};
	}
}
