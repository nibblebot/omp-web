import { Show, type Component } from "solid-js";
import type { SubagentNode } from "../../store/subagents";
import { formatCost, formatDuration, formatTokens } from "../../subagents/format";
import { createLiveElapsed } from "../../subagents/elapsed";
import { getContextUsageLevel } from "../../usage/context";
import { StatusSegment } from "../chat/status/StatusSegment";

/** Read-only status row under an agent's transcript, styled like the main session bar. Unknown values are omitted. */
export const SubagentStatusBar: Component<{ node: SubagentNode }> = (props) => {
	const elapsedMs = createLiveElapsed(() => props.node);
	const hasSubtree = () =>
		props.node.children.length > 0 &&
		(props.node.subtree.tokens !== undefined || props.node.subtree.cost !== undefined);
	return (
		<div class="session-bar subagent-status-bar">
			<Show when={props.node.model}>
				{(model) => (
					<>
						<StatusSegment readOnly class="model-segment" title={model().identity}>
							{model().id}
						</StatusSegment>
						<Show when={model().thinking}>
							{(level) => (
								<StatusSegment readOnly class="thinking-segment" title="Thinking level">
									{level()}
								</StatusSegment>
							)}
						</Show>
					</>
				)}
			</Show>
			<span class="status-spacer" />
			<Show when={props.node.metrics.contextPercent !== undefined}>
				<StatusSegment
					readOnly
					class="context-segment"
					dataLevel={getContextUsageLevel(props.node.metrics.contextPercent ?? 0, 0)}
					title={`${Math.round(props.node.metrics.contextPercent ?? 0)}% of the context window used`}
				>
					<span class="context-prefix">ctx </span>
					{Math.round(props.node.metrics.contextPercent ?? 0)}%
				</StatusSegment>
			</Show>
			<Show when={props.node.metrics.tokens !== undefined}>
				<StatusSegment readOnly class="stats-segment" title="Tokens used">
					{formatTokens(props.node.metrics.tokens)} tokens
				</StatusSegment>
			</Show>
			<Show when={props.node.metrics.cost !== undefined}>
				<StatusSegment readOnly class="stats-segment" title="Cost">
					{formatCost(props.node.metrics.cost)}
				</StatusSegment>
			</Show>
			<Show when={elapsedMs() !== undefined}>
				<StatusSegment readOnly class="stats-segment" title="Elapsed">
					{formatDuration(elapsedMs() ?? 0)}
				</StatusSegment>
			</Show>
			<Show when={hasSubtree()}>
				<StatusSegment
					readOnly
					class="stats-segment"
					title="Tokens and cost of this agent and everything it spawned"
				>
					subtree {formatTokens(props.node.subtree.tokens)}, {formatCost(props.node.subtree.cost)}
				</StatusSegment>
			</Show>
		</div>
	);
};
