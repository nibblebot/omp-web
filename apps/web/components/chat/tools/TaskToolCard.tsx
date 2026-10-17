import { Show, type Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { openDock } from "../../../store/dock";
import { fanoutTotals, subagentTree } from "../../../store/subagents";
import { SubagentFanoutFooter } from "../../subagents/SubagentFanoutFooter";
import { SubagentTree } from "../../subagents/SubagentTree";
import { ToolCardShell } from "./ToolCardShell";

/** task tool: the agent tree this tool call spawned (scoped by parentToolCallId).
 *  Rows open the agent pane; the footer totals the whole fan-out. */
export const TaskToolCard: Component<{ item: ToolItem }> = (props) => {
	const description = () => {
		const args = props.item.args as { description?: string; task?: string; prompt?: string } | null;
		return args?.description ?? args?.task ?? args?.prompt ?? "";
	};
	const forest = () => subagentTree(props.item.toolCallId);
	return (
		<ToolCardShell name={<>task {description()}</>} status={props.item.status} class="task-tool">
			<Show when={forest().length > 0}>
				<SubagentTree
					nodes={forest()}
					label="Agents spawned by this task"
					onOpen={(id) => openDock("agent", id)}
				/>
				<SubagentFanoutFooter totals={fanoutTotals(props.item.toolCallId)} />
			</Show>
		</ToolCardShell>
	);
};
