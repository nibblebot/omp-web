import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js";
import { planToggle } from "../../../prompt/commands";
import { setState, state } from "../../../state";
import { InfoIcon, SettingsIcon } from "../../ui/icons";
import { StatusSegment } from "./StatusSegment";

// Phase 9: live auto-retry countdown ("retry 2/5 · 3.2s"). Re-renders on a
// 100ms interval while a retry is pending; the interval dies with the effect
// cleanup when auto_retry_end clears retryInfo.
const RetryBadge: Component = () => {
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

export const StatusBar: Component = () => {
	return (
		<header class="status-bar">
			<Show when={state.compacting}>
				<span class="segment badge">compacting…</span>
			</Show>
			<Show when={state.goal}>
				{(g) => (
					<StatusSegment
						class="badge goal-badge"
						title={g().objective}
						onClick={() => setState("modal", "goal")}
					>
						goal: {g().objective.slice(0, 20)}
					</StatusSegment>
				)}
			</Show>
			<Show when={state.planModeEnabled}>
				<StatusSegment
					class="badge plan-badge"
					title="Plan mode, click to toggle (/plan)"
					onClick={planToggle}
				>
					plan
				</StatusSegment>
			</Show>
			<RetryBadge />
			{/* Historical transcripts/stats browser (fleet-only: /ctl/stats
			    needs a fleet process); the view buttons live in the sidebars. */}
			{state.queuedMessageCount > 0 && (
				<span class="queued-chip">queued: {state.queuedMessageCount}</span>
			)}
			<span class="status-spacer" />
			<Show when={state.subagents.size > 0}>
				<StatusSegment onClick={() => setState("modal", "subagents")}>
					subagents ({state.subagents.size})
				</StatusSegment>
			</Show>
			{/* Debug/settings segments live in the sidebar footer during Chat;
			    keep them in the header in the Analysis view, where no sidebar
			    footer renders. */}
			<Show when={state.view !== "chat"}>
				<StatusSegment
					active={state.modal === "debug"}
					onClick={() => setState("modal", state.modal === "debug" ? null : "debug")}
					title="Debug, transport and fleet visibility"
					ariaLabel="Debug, transport and fleet visibility"
				>
					<InfoIcon />
				</StatusSegment>
				<StatusSegment
					onClick={() => setState("modal", "settings")}
					title="Settings"
					ariaLabel="Settings"
				>
					<SettingsIcon />
				</StatusSegment>
			</Show>
			{!state.connected && <span class="disconnected-pill">disconnected</span>}
			{state.error && (
				<div class="error-banner" role="alert">
					<span>{state.error}</span>
					<button onClick={() => setState("error", null)}>dismiss</button>
				</div>
			)}
		</header>
	);
};
