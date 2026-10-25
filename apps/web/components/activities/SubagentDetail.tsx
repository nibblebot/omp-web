import { Show, type Component } from "solid-js";
import { subagentById } from "../../store/subagents";
import { SubagentActionsMenu } from "../subagents/SubagentActionsMenu";
import { SubagentConversation } from "../subagents/SubagentConversation";
import { SubagentStatusChip } from "../subagents/SubagentStatusChip";

/** One subagent filling the Activities panel (detail mode): header with lifecycle menu above its conversation. */
export const SubagentDetail: Component<{ id: string }> = (props) => {
	const node = () => subagentById(props.id);
	return (
		<Show
			when={node()}
			fallback={<p class="subagent-detail-missing">This agent is no longer in the session.</p>}
		>
			{(agent) => (
				<div class="subagent-detail">
					<header class="subagent-detail-head">
						<div class="subagent-detail-id">
							<h3 class="subagent-detail-name">{agent().name}</h3>
							<Show when={agent().agentType}>
								{(type) => <span class="subagent-tree-type">{type()}</span>}
							</Show>
							<SubagentStatusChip status={agent().status} />
							<SubagentActionsMenu id={props.id} label="More agent actions" lifecycle />
						</div>
						<p class="subagent-detail-title">{agent().title}</p>
					</header>
					<SubagentConversation id={props.id} />
				</div>
			)}
		</Show>
	);
};
