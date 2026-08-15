import { createEffect, createSignal, onCleanup, Show, type Component, type JSX } from "solid-js";
import { formatTokens, getContextUsageLevel } from "../context";
import { planToggle } from "../commands";
import { call, setState, state, togglePetVisible, toggleSidebar } from "../state";

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
					<span class="context-prefix">ctx </span>
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

// Declarative status-bar segment button: unifies the repeated
// `segment segment-button` + active/hover/title boilerplate. `class` adds
// variant classes (e.g. "badge goal-badge", "session-name").
const Segment: Component<{
	class?: string;
	title?: string;
	active?: boolean;
	onClick?: () => void;
	onContextMenu?: (e: MouseEvent) => void;
	children: JSX.Element;
}> = props => (
	<button
		class={props.class ? `segment segment-button ${props.class}` : "segment segment-button"}
		classList={{ active: !!props.active }}
		title={props.title}
		onClick={props.onClick}
		onContextMenu={props.onContextMenu}
	>
		{props.children}
	</button>
);

export const StatusBar: Component = () => {
	return (
		<header class="status-bar">
			<Show when={state.compacting}>
				<span class="segment badge">compacting…</span>
			</Show>
			<Show when={state.goal}>
				{g => (
					<Segment class="badge goal-badge" title={g().objective} onClick={() => setState("modal", "goal")}>
						goal: {g().objective.slice(0, 20)}
					</Segment>
				)}
			</Show>
			<Show when={state.planModeEnabled}>
				<Segment class="badge plan-badge" title="Plan mode — click to toggle (/plan)" onClick={planToggle}>
					plan
				</Segment>
			</Show>
			<RetryBadge />
			{/* Historical transcripts/stats browser; the /ctl/stats API only exists
			    with a fleet process, so the toggle is roster-mode-only. */}
			<Show when={state.sessionMode === "roster"}>
				<Segment
					active={state.view === "transcripts"}
					onClick={() => setState("view", v => (v === "transcripts" ? "chat" : "transcripts"))}
					title="Transcripts"
				>
					◫ Tx
				</Segment>
			</Show>
			{state.queuedMessageCount > 0 && <span class="queued-chip">queued: {state.queuedMessageCount}</span>}
			<span class="status-spacer" />
			<Show when={state.subagents.size > 0}>
				<Segment onClick={() => setState("modal", "subagents")}>
					subagents ({state.subagents.size})
				</Segment>
			</Show>
			<Segment active={state.petVisible} onClick={togglePetVisible} title="Show/hide pet roster">
				pet
			</Segment>
			<Segment
				active={state.toolsExpanded}
				onClick={() => setState("toolsExpanded", v => !v)}
				title="Expand all tool outputs (Ctrl+O)"
			>
				⤢
			</Segment>
			{/* Roster sidebar visibility toggle; hidden in single mode (no sidebar). */}
			<Show when={state.sessionMode === "roster"}>
				<Segment active={state.sidebarVisible} onClick={toggleSidebar} title="Roster">
					☰
				</Segment>
			</Show>
			<Segment
				active={state.modal === "debug"}
				onClick={() => setState("modal", state.modal === "debug" ? null : "debug")}
				title="Debug — transport and fleet visibility"
			>
				ⓘ
			</Segment>
			<Segment onClick={() => setState("modal", "settings")} title="Settings">
				⚙
			</Segment>
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

/** Session identity — the name (click to rename) pinned to the left edge
 *  directly above the session stream. Chrome and live state stay in
 *  StatusBar; send configuration sits in SessionBar by the composer. */
export const SessionHeader: Component = () => {
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
		<div class="session-header">
			<Show
				when={editingName()}
				fallback={
					<Segment class="session-name" onClick={() => setEditingName(true)} title="Rename session">
						{state.sessionName ?? state.sessionId.slice(0, 8)}
					</Segment>
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
		</div>
	);
};

/** Session-send configuration (model, thinking) plus the session resource
 *  meters (ctx fill, cumulative stats) — pinned directly above the composer,
 *  where the send decision happens. Live turn-state (retry, badges) and
 *  global chrome stay in StatusBar. */
export const SessionBar: Component = () => (
	<div class="session-bar">
		<Segment class="model-segment" onClick={() => setState("modal", "model")} title="Model roles">
			{state.model ? `${state.model.provider}/${state.model.id}` : "no model"}
		</Segment>
		<Segment
			class="thinking-segment"
			onClick={() => void call("cycleThinkingLevel").catch(err => setState("error", String(err)))}
			onContextMenu={e => {
				e.preventDefault();
				setState("modal", "thinking");
			}}
			title="Click: cycle thinking level · right-click: pick"
		>
			{state.thinkingLevel ?? "inherit"}
		</Segment>
		<span class="status-spacer" />
		<ContextSegment />
		<Show when={state.stats}>
			{s => (
				<Segment onClick={() => setState("modal", "stats")} title="Session stats">
					${s().cost.toFixed(2)} · ↑{formatTokens(s().tokens.input)} ↓{formatTokens(s().tokens.output)}
				</Segment>
			)}
		</Show>
	</div>
);
