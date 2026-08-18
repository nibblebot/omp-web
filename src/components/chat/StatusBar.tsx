import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js";
import { planToggle } from "../../prompt/commands";
import { setState, state } from "../../state";
import { InfoIcon, SettingsIcon } from "../shared/icons";
import { Segment } from "./status-utils";

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
					<Segment
						class="badge goal-badge"
						title={g().objective}
						onClick={() => setState("modal", "goal")}
					>
						goal: {g().objective.slice(0, 20)}
					</Segment>
				)}
			</Show>
			<Show when={state.planModeEnabled}>
				<Segment
					class="badge plan-badge"
					title="Plan mode — click to toggle (/plan)"
					onClick={planToggle}
				>
					plan
				</Segment>
			</Show>
			<RetryBadge />
			{/* Historical transcripts/stats browser (roster-mode-only: /ctl/stats
			    needs a fleet process); the toggle lives in the sidebar footer. */}
			{state.queuedMessageCount > 0 && (
				<span class="queued-chip">queued: {state.queuedMessageCount}</span>
			)}
			<span class="status-spacer" />
			<Show when={state.subagents.size > 0}>
				<Segment onClick={() => setState("modal", "subagents")}>
					subagents ({state.subagents.size})
				</Segment>
			</Show>
			{/* debug/settings live in the DaemonSidebar footer in roster chat;
			    keep them in the header where no sidebar exists (standalone, Tx view). */}
			<Show when={state.sessionMode !== "roster" || state.view !== "chat"}>
				<Segment
					active={state.modal === "debug"}
					onClick={() => setState("modal", state.modal === "debug" ? null : "debug")}
					title="Debug — transport and fleet visibility"
					ariaLabel="Debug — transport and fleet visibility"
				>
					<InfoIcon />
				</Segment>
				<Segment
					onClick={() => setState("modal", "settings")}
					title="Settings"
					ariaLabel="Settings"
				>
					<SettingsIcon />
				</Segment>
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
