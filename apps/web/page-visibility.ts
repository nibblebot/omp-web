import { onCleanup } from "solid-js";

/** Whether the tab is in front. True where there is no document (a test worker): nothing there is hidden. */
export function isPageVisible(): boolean {
	return typeof document === "undefined" || document.visibilityState === "visible";
}

/**
 * `setInterval` for background work that only matters to someone looking at the tab (clocks, polls): it
 * runs while the page is visible, stops while it is hidden, and on becoming visible again ticks once
 * at once (so a clock or a poll is current when the user returns) and restarts the period. Stops with
 * the calling owner; call it inside a component, effect or root.
 */
export function createVisibleInterval(tick: () => void, periodMs: number): void {
	let timer: ReturnType<typeof setInterval> | undefined;
	const start = () => {
		timer ??= setInterval(tick, periodMs);
	};
	const stop = () => {
		clearInterval(timer);
		timer = undefined;
	};
	const onChange = () => {
		if (!isPageVisible()) {
			stop();
			return;
		}
		tick();
		start();
	};
	if (isPageVisible()) start();
	if (typeof document !== "undefined") document.addEventListener("visibilitychange", onChange);
	onCleanup(() => {
		stop();
		if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onChange);
	});
}
