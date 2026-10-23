import { Show, type Component } from "solid-js";
import { subagentById } from "../../store/subagents";
import { SubagentActionsMenu } from "./SubagentActionsMenu";
import { SubagentConversation } from "./SubagentConversation";
import { SubagentStatusChip } from "./SubagentStatusChip";

/** Agent pane (single view): header with lifecycle menu above the agent's conversation. */
export const SubagentPanel: Component<{ id?: string }> = (props) => {
	const id = () => props.id ?? "";
	const node = () => (props.id ? subagentById(props.id) : undefined);
	return (
		<Show
			when={node()}
			fallback={<p class="subagent-panel-missing">This agent is no longer in the session.</p>}
		>
			{(agent) => (
				<div class="subagent-panel">
					<header class="subagent-panel-head">
						<div class="subagent-panel-id">
							<h3 class="subagent-panel-name">{agent().name}</h3>
							<Show when={agent().agentType}>
								{(type) => <span class="subagent-tree-type">{type()}</span>}
							</Show>
							<SubagentStatusChip status={agent().status} />
							<SubagentActionsMenu id={id()} label="More agent actions" lifecycle />
						</div>
						<p class="subagent-panel-title">{agent().title}</p>
					</header>
					<SubagentConversation id={id()} />
				</div>
			)}
		</Show>
	);
};
