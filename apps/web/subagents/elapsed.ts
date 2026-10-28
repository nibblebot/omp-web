import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js";
import type { SubagentNode } from "../store/subagents";

/** One shared 1 s ticker for every running row: it runs only while some row is mounted and running. */
const [tick, setTick] = createSignal(0);
let holders = 0;
let timer: ReturnType<typeof setInterval> | undefined;

function holdTicker(): void {
	if (holders === 0) timer = setInterval(() => setTick((n) => n + 1), 1000);
	holders += 1;
	onCleanup(() => {
		holders -= 1;
		if (holders === 0) clearInterval(timer);
	});
}

/**
 * Elapsed time of one agent, ticking every second while it runs. Progress frames can pause for a
 * whole tool call, so a running agent counts from `startedAt`; otherwise the settled metric wins.
 * Undefined while pending. The row holds the ticker only while it runs, keyed on its status and not
 * on the node object, so a progress frame never re-arms anything.
 */
export function createLiveElapsed(node: Accessor<SubagentNode>): Accessor<number | undefined> {
	const running = createMemo(() => node().status === "running");
	createEffect(() => {
		if (running()) holdTicker();
	});
	return () => {
		const { status, startedAt, metrics } = node();
		if (status === "pending") return undefined;
		if (status !== "running" || startedAt === undefined) return metrics.elapsedMs;
		tick();
		return Math.max(0, Date.now() - startedAt);
	};
}
