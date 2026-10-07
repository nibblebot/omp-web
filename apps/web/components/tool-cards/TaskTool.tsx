import { For, Show, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";
import { latestSubagent, SubagentRow } from "../shared/SubagentRow";
import { ToolShell } from "./ToolShell";

/** task tool: the agent list this tool call spawned, scoped by parentToolCallId
 *  (the SDK stamps every subagent lifecycle/progress payload with the spawning
 *  task call's id; entries without it predate the association and are skipped). */
export const TaskTool: Component<{ item: ToolItem }> = (props) => {
	const description = () => {
		const args = props.item.args as { description?: string; task?: string; prompt?: string } | null;
		return args?.description ?? args?.task ?? args?.prompt ?? "";
	};
	const subIds = () =>
		[...state.subagents.values()]
			.filter((sub) => sub.parentToolCallId === props.item.toolCallId)
			.sort((a, b) => a.index - b.index)
			.map((sub) => sub.id);
	return (
		<ToolShell name={<>task {description()}</>} status={props.item.status} class="task-tool">
			<Show when={subIds().length > 0}>
				<div class="subagent-list">
					<For each={subIds()}>
						{(id) => {
							const sub = latestSubagent((key) => state.subagents.get(key), id);
							return <SubagentRow sub={sub()} />;
						}}
					</For>
				</div>
			</Show>
		</ToolShell>
	);
};
