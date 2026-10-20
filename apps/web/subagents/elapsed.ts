import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { SubagentNode } from "../store/subagents";

/**
 * Elapsed time of one agent, ticking every second while it runs. Progress frames
 * can pause for a whole tool call, so a running agent counts from `startedAt`;
 * otherwise the settled metric wins. Undefined while pending.
 */
export function createLiveElapsed(node: Accessor<SubagentNode>): Accessor<number | undefined> {
	const [now, setNow] = createSignal(Date.now());
	createEffect(() => {
		if (node().status !== "running") return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		onCleanup(() => clearInterval(timer));
	});
	return () => {
		const { status, startedAt, metrics } = node();
		if (status === "pending") return undefined;
		return status === "running" && startedAt !== undefined
			? Math.max(0, now() - startedAt)
			: metrics.elapsedMs;
	};
}
