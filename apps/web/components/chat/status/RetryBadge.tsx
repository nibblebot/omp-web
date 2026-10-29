import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js";
import { pageVisible } from "../../../page-visibility";
import { state } from "../../../state";

// Live auto-retry countdown ("retry 2/5 · 4s"). The text reads the clock signal, which ticks on the
// second boundaries of `until` (the label is the ceiling of the seconds left, so it flips exactly
// when a second is used up), not on a free-running 1 s period from when the effect started. The
// timer dies with the effect cleanup when auto_retry_end clears retryInfo or the tab is hidden; the
// effect re-runs, and ticks at once, when the tab shows again.
export const RetryBadge: Component = () => {
	const [now, setNow] = createSignal(Date.now());
	createEffect(() => {
		const until = state.retryInfo?.until;
		if (until === undefined || !pageVisible()) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			const t = Date.now();
			setNow(t);
			if (t < until) timer = setTimeout(tick, (until - t) % 1000 || 1000);
		};
		tick();
		onCleanup(() => clearTimeout(timer));
	});
	return (
		<Show when={state.retryInfo}>
			{(r) => (
				<span
					class="segment badge retry-badge"
					title={`auto-retry ${r().attempt}/${r().maxAttempts}`}
				>
					retry {r().attempt}/{r().maxAttempts} · {Math.ceil(Math.max(0, r().until - now()) / 1000)}
					s
				</span>
			)}
		</Show>
	);
};
