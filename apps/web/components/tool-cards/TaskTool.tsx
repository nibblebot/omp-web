import { For, Show, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";
import { SubagentRow } from "../shared/SubagentRow";
import { ToolShell } from "./ToolShell";

/** task tool: the agent list this tool call spawned, scoped by parentToolCallId
 *  (the SDK stamps every subagent lifecycle/progress payload with the spawning
 *  task call's id; entries without it predate the association and are skipped). */
export const TaskTool: Component<{ item: ToolItem }> = (props) => {
	const description = () => {
		const args = props.item.args as { description?: string; task?: string; prompt?: string } | null;
		return args?.description ?? args?.task ?? args?.prompt ?? "";
	};
	const subs = () =>
		[...state.subagents.values()]
			.filter((sub) => sub.parentToolCallId === props.item.toolCallId)
			.sort((a, b) => a.index - b.index);
	return (
		<ToolShell name={<>task {description()}</>} status={props.item.status} class="task-tool">
			<Show when={subs().length > 0}>
				<div class="subagent-list">
					<For each={subs()}>{(sub) => <SubagentRow sub={sub} />}</For>
				</div>
			</Show>
		</ToolShell>
	);
};
