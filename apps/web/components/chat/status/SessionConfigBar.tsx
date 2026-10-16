import { Show, type Component } from "solid-js";
import { planToggle } from "../../../prompt/commands";
import { formatTokens, getContextUsageLevel } from "../../../usage/context";
import { call, setState, state } from "../../../state";
import { ArrowDownIcon, ArrowUpIcon } from "../../ui/icons";
import { isCoarsePointer } from "../pointer";
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
					title={`${formatTokens(u().tokens)} / ${formatTokens(u().contextWindow)} tokens · session stats`}
					onClick={() => setState("modal", "stats")}
				>
					<span class="context-prefix">ctx </span>
					{u().percent.toFixed(0)}%
				</StatusSegment>
			)}
		</Show>
	);
};

/** Session-send configuration (model, thinking) plus the session resource
 *  meters (ctx fill, cumulative stats), pinned directly above the composer,
 *  where the send decision happens. Per-turn badges (compacting, retry,
 *  plan) lead the row and show only while active. */
export const SessionConfigBar: Component = () => (
	<div class="session-bar">
		<Show when={state.compacting}>
			<span class="segment badge">compacting…</span>
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
		<StatusSegment
			class="model-segment"
			onClick={() => setState("modal", "model")}
			title="Model roles"
		>
			{state.model ? `${state.model.provider}/${state.model.id}` : "no model"}
		</StatusSegment>
		<StatusSegment
			class="thinking-segment"
			onClick={() => {
				// Touch has no right-click: on coarse pointers a tap opens the picker.
				if (isCoarsePointer()) {
					setState("modal", "thinking");
					return;
				}
				void call("cycleThinkingLevel").catch((err) => setState("error", String(err)));
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				setState("modal", "thinking");
			}}
			title={`Click: cycle thinking level · right-click: pick${state.autoThinking && state.thinkingLevel ? ` (auto: ${state.thinkingLevel})` : ""}`}
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
					${s().cost.toFixed(2)} · <ArrowUpIcon />
					{formatTokens(s().tokens.input)} <ArrowDownIcon />
					{formatTokens(s().tokens.output)}
				</StatusSegment>
			)}
		</Show>
	</div>
);
