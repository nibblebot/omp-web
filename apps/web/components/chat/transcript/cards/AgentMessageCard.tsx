import { Show, type Component } from "solid-js";
import type { AgentMessageItem } from "../../../../store/slices/agent-message";

/**
 * Agent message card: a message another agent (a subagent, a peer, the parent)
 * sent this session, labeled with its sender, live as it is delivered and after
 * reload. Since SDK 18.18.9 this is also where a message that ended a `wait`
 * shows; older transcripts kept it in the wait's result.
 */
export const AgentMessageCard: Component<{ item: AgentMessageItem }> = (props) => (
	<div class="agent-message" aria-label={`Message from agent ${props.item.from}`}>
		<div class="agent-message-from">Message from {props.item.from}</div>
		<Show when={props.item.text !== ""}>
			<div class="agent-message-text">{props.item.text}</div>
		</Show>
	</div>
);
