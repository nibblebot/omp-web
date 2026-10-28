/**
 * Calls `onMove` when `anchor`'s viewport rect (or the viewport) changed, with no per-frame polling: a resize or
 * scroll anywhere, a size change of the anchor (ResizeObserver), and any other layout shift that moves it
 * (an IntersectionObserver whose root is shrunk to the anchor's own rect, so the anchor stops being fully
 * visible in it as soon as it moves; the observer is rebuilt around the new rect after each move).
 * Returns the stop function.
 */
export function trackAnchor(anchor: HTMLElement, onMove: () => void): () => void {
	const root = anchor.ownerDocument.documentElement;
	const read = () => {
		const r = anchor.getBoundingClientRect();
		return [r.left, r.top, r.right, r.bottom, root.clientWidth, root.clientHeight];
	};
	let seen = read();
	// A scroll anywhere reports here; most do not move the anchor, and those stay silent.
	const check = () => {
		const now = read();
		if (now.every((v, i) => v === seen[i])) return;
		seen = now;
		onMove();
	};
	// The anchor resizing or the viewport resizing leaves the shift observer's rect stale: rebuild it.
	const rebase = () => {
		check();
		shift.rewatch();
	};
	const resize = new ResizeObserver(rebase);
	resize.observe(anchor);
	window.addEventListener("resize", rebase);
	// Capture: scroll does not bubble, and any scrollable ancestor can move the anchor.
	window.addEventListener("scroll", check, { capture: true, passive: true });
	const shift = observeShift(anchor, check);
	return () => {
		resize.disconnect();
		window.removeEventListener("resize", rebase);
		window.removeEventListener("scroll", check, { capture: true });
		shift.stop();
	};
}

/** The IntersectionObserver half of {@link trackAnchor}: `onShift` fires when the anchor leaves the rect it had. */
function observeShift(
	anchor: HTMLElement,
	onShift: () => void,
): { stop: () => void; rewatch: () => void } {
	const root = anchor.ownerDocument.documentElement;
	let io: IntersectionObserver | undefined;
	let retry: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		clearTimeout(retry);
		io?.disconnect();
		io = undefined;
	};
	const watch = (threshold: number) => {
		stop();
		const { left, top, width, height } = anchor.getBoundingClientRect();
		if (width === 0 || height === 0) return;
		const rootMargin = [
			-Math.floor(top),
			-Math.floor(root.clientWidth - (left + width)),
			-Math.floor(root.clientHeight - (top + height)),
			-Math.floor(left),
		]
			.map((px) => `${px}px`)
			.join(" ");
		let first = true;
		io = new IntersectionObserver(
			(entries) => {
				const ratio = entries[0]!.intersectionRatio;
				if (ratio !== threshold) {
					if (!first) {
						onShift();
						watch(1);
						return;
					}
					// First report below the threshold: an anchor clipped by the viewport or an ancestor.
					// Watch for change from the ratio it has; a ratio of 0 (fully clipped) retries later, never in a tight loop.
					if (ratio === 0) retry = setTimeout(() => watch(1e-7), 1000);
					else watch(ratio);
				}
				first = false;
			},
			{ root: anchor.ownerDocument, rootMargin, threshold },
		);
		io.observe(anchor);
	};
	watch(1);
	return { stop, rewatch: () => watch(1) };
}
