import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js";
import { state } from "../../../state";

// Live auto-retry countdown ("retry 2/5 · 3.2s"). Re-renders on a 100ms
// interval while a retry is pending; the interval dies with the effect
// cleanup when auto_retry_end clears retryInfo.
export const RetryBadge: Component = () => {
	const [now, setNow] = createSignal(Date.now());
	createEffect(() => {
		if (!state.retryInfo) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), 100);
		onCleanup(() => clearInterval(id));
	});
	return (
		<Show when={state.retryInfo}>
			{(r) => {
				const remainingMs = Math.max(0, r().until - now());
				return (
					<span
						class="segment badge retry-badge"
						title={`auto-retry ${r().attempt}/${r().maxAttempts}`}
					>
						retry {r().attempt}/{r().maxAttempts} · {(remainingMs / 1000).toFixed(1)}s
					</span>
				);
			}}
		</Show>
	);
};
