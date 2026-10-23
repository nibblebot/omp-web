import { Show, type Component } from "solid-js";
import { formatCost, formatDuration, formatTokens } from "../../subagents/format";
import type { SubagentTotals } from "../../subagents/tree";

/** Totals of a fan-out or the whole forest: count, running, failed, tokens, cost, elapsed.
 *  `header` sits inline in the task card header; `footer` is the agents panel's bottom strip. */
export const SubagentFanoutTotals: Component<{
	totals: SubagentTotals;
	placement: "header" | "footer";
}> = (props) => (
	<span class="subagent-fanout-totals" data-placement={props.placement}>
		<span>{props.totals.count} agents</span>
		<span>{props.totals.running} running</span>
		<Show when={props.totals.failed > 0}>
			<span class="subagent-fanout-failed">{props.totals.failed} failed</span>
		</Show>
		<span>{formatTokens(props.totals.tokens)} tokens</span>
		<span>{formatCost(props.totals.cost)}</span>
		<span>{formatDuration(props.totals.elapsedMs)}</span>
	</span>
);
