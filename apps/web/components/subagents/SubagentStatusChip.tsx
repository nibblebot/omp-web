import type { Component } from "solid-js";
import type { SubagentStatus } from "../../store/subagents";

/** Status as text, with `data-status` for color. Color is never the only signal. */
export const SubagentStatusChip: Component<{ status: SubagentStatus }> = (props) => (
	<span class="subagent-status-chip" data-status={props.status}>
		{props.status}
	</span>
);
