/** Chips the queue bar shows, and how many of them a Stop paused. */
export interface QueueCounts {
	chips: number;
	paused: number;
}

/**
 * The operator action that is about to drain the queue. Absent means the
 * running turn consumed the chips (delivered them), not the operator.
 */
export type QueueExit = "cleared" | "removed";

const messages = (n: number): string => `${n} message${n === 1 ? "" : "s"}`;

/**
 * The live-region announcement for one queue transition, or undefined to keep
 * the last one. A drain to zero names what happened: "Queue cleared" only for
 * clear all, silence for a chip the operator removed, and "delivered" when the
 * turn consumed the messages (including a steer taken when Stop lands).
 */
export function queueTransitionNotice(
	prev: QueueCounts,
	next: QueueCounts,
	exit?: QueueExit,
): string | undefined {
	if (next.chips === 0) {
		if (prev.chips === 0) return undefined;
		if (exit === "cleared") return "Queue cleared";
		if (exit === "removed") return "";
		return `${messages(prev.chips)} delivered`;
	}
	if (next.paused > prev.paused) {
		return `${messages(next.paused)} paused. Resume queue to send`;
	}
	if (prev.chips === 0) return `${messages(next.chips)} queued`;
	return undefined;
}
