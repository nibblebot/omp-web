import { createEffect, createSignal, on, onCleanup, onMount, type Accessor } from "solid-js";

export interface GrowingCount {
	/** How many of the `total` items to render now. */
	count: Accessor<number>;
	/** Render at least the first `n` items at once, e.g. before scrolling to one. */
	reach: (n: number) => void;
	/** Start over at the first slice (a new search). */
	reset: () => void;
	/** `ref` of a zero-height element placed after the rendered items. */
	marker: (el: HTMLElement) => void;
}

/**
 * A render budget for a long list inside a scroll container: `first` items to start, then `step`
 * more whenever the marker after them comes within a container height of the viewport, either side. The rest
 * never mounts unless it is scrolled toward (or `reach`ed), so opening and closing cost what is
 * near the viewport, not what the list holds. Call it in a component body; `root` is read on mount.
 */
export function createGrowingCount(
	total: Accessor<number>,
	first: number,
	step: number,
	root: () => HTMLElement,
): GrowingCount {
	const [shown, setShown] = createSignal(first);
	const count = () => Math.min(shown(), total());
	let current: HTMLElement | undefined;
	let observer: IntersectionObserver | undefined;
	// An observer reports a change of intersection, not a state: after each mount observe the marker
	// again so it reports whether the viewport still reaches it.
	const rearm = () => {
		if (!current) return;
		observer?.unobserve(current);
		observer?.observe(current);
	};
	createEffect(on([shown, total], rearm, { defer: true }));
	onMount(() => {
		observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting) && count() < total())
					setShown((n) => n + step);
			},
			{ root: root(), rootMargin: "100% 0px" },
		);
		if (current) observer.observe(current);
	});
	onCleanup(() => observer?.disconnect());
	return {
		count,
		reach: (n) => setShown((c) => Math.max(c, n)),
		reset: () => setShown(first),
		marker: (el) => {
			if (current && current !== el) observer?.unobserve(current);
			current = el;
			observer?.observe(el);
		},
	};
}
