import { Show, type Component } from "solid-js";
import { planToggle } from "../../../prompt/commands";
import { cycleModelPreset, openModelPicker, openThinkingPicker } from "../../../store/models";
import { formatTokens, getContextUsageLevel } from "../../../usage/context";
import { isReady, isSessionChanging, setState, state } from "../../../state";
import { ArrowDownIcon, ArrowUpIcon } from "../../ui/icons";
import { RetryBadge } from "./RetryBadge";
import { StatusSegment } from "./StatusSegment";

const ContextSegment: Component = () => {
	const usage = () => state.contextUsage;
	const level = () =>
		usage() ? getContextUsageLevel(usage()!.percent, usage()!.contextWindow) : "normal";
	return (
		<Show when={usage()}>
			{(u) => (
				<StatusSegment
					class="context-segment"
					dataLevel={level()}
					title={`${formatTokens(u().tokens)} of ${formatTokens(u().contextWindow)} tokens used · session stats`}
					onClick={() => setState("modal", "stats")}
				>
					<span class="context-prefix">ctx </span>
					{formatTokens(u().tokens)} / {formatTokens(u().contextWindow)}
				</StatusSegment>
			)}
		</Show>
	);
};

/** Roster-derived status for the attached session while the composer is gated. */
const rosterHint = (): string => {
	const daemon = state.daemonRoster.find((x) => x.daemonId === state.currentSessionId);
	if (!daemon) return "no workspace attached, pick one in the sidebar";
	if (daemon.status === "ready") return "attaching to session process…";
	return `session process ${daemon.status}…`;
};

/** Session-send configuration (model, preset, thinking) plus the session resource
 *  meters (ctx fill, cumulative stats), attached directly below the composer
 *  as its bottom row. Per-turn badges (starting, compacting, retry, plan) lead
 *  the row and show only while active. */
export const SessionConfigBar: Component = () => (
	<div class="session-bar">
		{/* Boot readiness gate pill (the connection strip covers disconnects):
		    show the attached session's status instead of a generic phrase. */}
		<Show when={state.connected && !isReady()}>
			<span
				class="segment badge ready-pill"
				title="The attached session is still starting (or reconnecting)…"
			>
				{rosterHint()}
			</span>
		</Show>
		<Show when={state.connected && isReady() && isSessionChanging()}>
			<span
				class="segment badge ready-pill"
				title="The daemon is replacing the session; sending resumes once the new session is shown."
			>
				starting new session…
			</span>
		</Show>
		<Show when={state.compacting}>
			<span class="segment badge">compacting…</span>
		</Show>
		<Show when={state.planModeEnabled}>
			<StatusSegment
				class="badge plan-badge"
				title="Plan mode on · click to exit"
				onClick={planToggle}
			>
				Plan mode
			</StatusSegment>
		</Show>
		<RetryBadge />
		<StatusSegment
			class="model-segment"
			onClick={() => openModelPicker()}
			title="Switch model (Alt+P). Session-only."
		>
			{state.model ? `${state.model.provider}/${state.model.id}` : "no model"}
		</StatusSegment>
		<Show when={(state.modelPresets?.names.length ?? 0) > 0}>
			<StatusSegment
				class="preset-segment"
				onClick={() => void cycleModelPreset()}
				title="Cycle model presets (/modelpreset)"
			>
				{state.modelPresets?.active ?? "preset"}
			</StatusSegment>
		</Show>
		<StatusSegment
			class="thinking-segment"
			onClick={() => openThinkingPicker()}
			onContextMenu={(e) => {
				e.preventDefault();
				openThinkingPicker();
			}}
			title="Thinking level (Shift+Tab cycles). Right-click or click to pick."
		>
			{state.autoThinking ? "auto" : (state.thinkingLevel ?? "inherit")}
		</StatusSegment>
		<span class="status-spacer" />
		<ContextSegment />
		<Show when={state.stats}>
			{(s) => (
				<StatusSegment
					class="stats-segment"
					onClick={() => setState("modal", "stats")}
					title="Session stats"
				>
					${s().cost.toFixed(2)}
					<span class="stats-tokens">
						· <ArrowUpIcon />
						{formatTokens(s().tokens.input)} <ArrowDownIcon />
						{formatTokens(s().tokens.output)}
					</span>
				</StatusSegment>
			)}
		</Show>
	</div>
);
