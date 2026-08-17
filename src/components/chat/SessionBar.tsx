import { Show, type Component } from "solid-js";
import { formatTokens, getContextUsageLevel } from "../../context";
import { call, setState, state } from "../../state";
import { ArrowDownIcon, ArrowUpIcon } from "../shared/icons";
import { Segment } from "./status-utils";

const ContextSegment: Component = () => {
	const usage = () => state.contextUsage;
	const level = () =>
		usage() ? getContextUsageLevel(usage()!.percent, usage()!.contextWindow) : "normal";
	return (
		<Show when={usage()}>
			{(u) => (
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
			onClick={() => void call("cycleThinkingLevel").catch((err) => setState("error", String(err)))}
			onContextMenu={(e) => {
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
			{(s) => (
				<Segment
					class="stats-segment"
					onClick={() => setState("modal", "stats")}
					title="Session stats"
				>
					${s().cost.toFixed(2)} · <ArrowUpIcon />
					{formatTokens(s().tokens.input)} <ArrowDownIcon />
					{formatTokens(s().tokens.output)}
				</Segment>
			)}
		</Show>
	</div>
);
