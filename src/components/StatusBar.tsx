import { createEffect, createSignal, onCleanup, Show, type Component } from "solid-js";
import { formatTokens, getContextUsageLevel } from "../context";
import { planToggle } from "../commands";
import { call, setState, state, toggleSidebar } from "../state";

const ContextSegment: Component = () => {
	const usage = () => state.contextUsage;
	const level = () => (usage() ? getContextUsageLevel(usage()!.percent, usage()!.contextWindow) : "normal");
	return (
		<Show when={usage()}>
			{u => (
				<span
					class="segment context-segment"
					data-level={level()}
					title={`${formatTokens(u().tokens)} / ${formatTokens(u().contextWindow)} tokens`}
				>
					{u().percent.toFixed(0)}%
				</span>
			)}
		</Show>
	);
};

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
			{r => {
				const remainingMs = Math.max(0, r().until - now());
				return (
					<span class="segment badge retry-badge" title={`auto-retry ${r().attempt}/${r().maxAttempts}`}>
						retry {r().attempt}/{r().maxAttempts} · {(remainingMs / 1000).toFixed(1)}s
					</span>
				);
			}}
		</Show>
	);
};

export const StatusBar: Component = () => {
	const [editingName, setEditingName] = createSignal(false);
	// Enter commits and closes first, so the trailing blur is a harmless no-op.
	const commitName = (el: HTMLInputElement) => {
		const title = el.value.trim();
		setEditingName(false);
		if (title && title !== state.sessionName) {
			void call("setSessionName", [title]).catch(err => setState("error", String(err)));
		}
	};

	return (
		<header class="status-bar">
			<button class="segment segment-button" onClick={() => setState("modal", "model")} title="Switch model">
				{state.model ? `${state.model.provider}/${state.model.id}` : "no model"}
				{state.thinkingLevel && state.thinkingLevel !== "inherit" && <span class="thinking-suffix"> · {state.thinkingLevel}</span>}
			</button>
			<button
				class="segment segment-button thinking-segment"
				onClick={() => void call("cycleThinkingLevel").catch(err => setState("error", String(err)))}
				onContextMenu={e => {
					e.preventDefault();
					setState("modal", "thinking");
				}}
				title="Click: cycle thinking level · right-click: pick"
			>
				{state.thinkingLevel ?? "inherit"}
			</button>
			<Show when={state.compacting}>
				<span class="segment badge">compacting…</span>
			</Show>
			<Show when={state.goal}>
				{g => (
					<button class="segment segment-button badge goal-badge" title={g().objective} onClick={() => setState("modal", "goal")}>
						goal: {g().objective.slice(0, 20)}
					</button>
				)}
			</Show>
			<Show when={state.planModeEnabled}>
				<button
					class="segment segment-button badge plan-badge"
					title="Plan mode — click to toggle (/plan)"
					onClick={planToggle}
				>
					plan
				</button>
			</Show>
			<RetryBadge />
			<ContextSegment />
			<Show when={state.stats}>
				{s => (
					<button class="segment segment-button" onClick={() => setState("modal", "stats")} title="Session stats">
						${s().cost.toFixed(2)} · ↑{formatTokens(s().tokens.input)} ↓{formatTokens(s().tokens.output)}
					</button>
				)}
			</Show>
			{state.queuedMessageCount > 0 && <span class="queued-chip">queued: {state.queuedMessageCount}</span>}
			<span class="status-spacer" />
			<Show when={state.subagents.size > 0}>
				<button class="segment segment-button" onClick={() => setState("modal", "subagents")}>
					subagents ({state.subagents.size})
				</button>
			</Show>
			<button
				class="segment segment-button"
				classList={{ active: state.toolsExpanded }}
				onClick={() => setState("toolsExpanded", v => !v)}
				title="Expand all tool outputs (Ctrl+O)"
			>
				⤢
			</button>
			<button
				class="segment segment-button"
				classList={{ active: state.sidebarVisible }}
				onClick={toggleSidebar}
				title="Sessions"
			>
				☰
			</button>
			<Show
				when={editingName()}
				fallback={
					<button class="segment segment-button session-name" onClick={() => setEditingName(true)} title="Rename session">
						{state.sessionName ?? state.sessionId.slice(0, 8)}
					</button>
				}
			>
				<input
					ref={el => queueMicrotask(() => { el.focus(); el.select(); })}
					class="segment session-name-input"
					value={state.sessionName ?? ""}
					onKeyDown={e => {
						if (e.key === "Enter") commitName(e.currentTarget);
						else if (e.key === "Escape") setEditingName(false);
					}}
					onBlur={() => setEditingName(false)}
				/>
			</Show>
			<button class="segment segment-button" onClick={() => setState("modal", "settings")} title="Settings">
				⚙
			</button>
			{!state.connected && <span class="disconnected-pill">disconnected</span>}
			<span class="status-dot" classList={{ streaming: state.streaming }} title={state.streaming ? "streaming" : "idle"} />
			{state.error && (
				<div class="error-banner">
					<span>{state.error}</span>
					<button onClick={() => setState("error", null)}>dismiss</button>
				</div>
			)}
		</header>
	);
};
