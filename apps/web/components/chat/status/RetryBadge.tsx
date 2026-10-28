import { createEffect, createSignal, Show, type Component } from "solid-js";
import { createVisibleInterval } from "../../../page-visibility";
import { state } from "../../../state";

// Live auto-retry countdown ("retry 2/5 · 4s"). The text reads the clock signal, so it re-renders
// once a second while a retry is pending; the interval dies with the effect cleanup when
// auto_retry_end clears retryInfo, and sleeps while the tab is hidden.
export const RetryBadge: Component = () => {
	const [now, setNow] = createSignal(Date.now());
	createEffect(() => {
		if (!state.retryInfo) return;
		setNow(Date.now());
		createVisibleInterval(() => setNow(Date.now()), 1000);
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
