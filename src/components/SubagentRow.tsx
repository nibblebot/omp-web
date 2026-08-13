import type { Component } from "solid-js";
import type { SubagentInfo } from "../state";

export const STATUS_GLYPH: Record<string, string> = {
	started: "◐",
	running: "◐",
	completed: "✓",
	done: "✓",
	failed: "✗",
	error: "✗",
	aborted: "⊘",
};

/** One roster row for a subagent: status glyph, agent, description, status text. */
export const SubagentRow: Component<{ sub: SubagentInfo }> = props => (
	<div class="subagent-row">
		<span class="subagent-glyph" data-status={props.sub.status}>
			{STATUS_GLYPH[props.sub.status] ?? "◐"}
		</span>
		<span class="subagent-agent">{props.sub.agent}</span>
		<span class="subagent-desc">{props.sub.description ?? props.sub.task ?? ""}</span>
		<span class="subagent-status">{props.sub.status}</span>
	</div>
);
