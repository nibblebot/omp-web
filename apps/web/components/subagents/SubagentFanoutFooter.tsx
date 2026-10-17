import { Show, type Component } from "solid-js";
import { formatCost, formatDuration, formatTokens } from "../../subagents/format";
import type { SubagentTotals } from "../../subagents/tree";

/** Totals under a fan-out or the whole forest: count, running, failed, tokens, cost, elapsed. */
export const SubagentFanoutFooter: Component<{ totals: SubagentTotals }> = (props) => (
	<div class="subagent-fanout-footer">
		<span>{props.totals.count} agents</span>
		<span>{props.totals.running} running</span>
		<Show when={props.totals.failed > 0}>
			<span class="subagent-fanout-failed">{props.totals.failed} failed</span>
		</Show>
		<span>{formatTokens(props.totals.tokens)} tokens</span>
		<span>{formatCost(props.totals.cost)}</span>
		<span>{formatDuration(props.totals.elapsedMs)}</span>
	</div>
);
