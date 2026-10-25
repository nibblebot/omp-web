import { createMemo, Show, type Component } from "solid-js";
import { effectiveStatus } from "../../../chat/background-job";
import type { ToolItem } from "../../../state";
import { openAgent } from "../../../store/dock";
import { fanoutTotals, subagentTree } from "../../../store/subagents";
import { SubagentFanoutTotals } from "../../subagents/SubagentFanoutTotals";
import { SubagentTree } from "../../subagents/SubagentTree";
import { createStableSubagentOrder } from "../../../subagents/tree";
import { ToolCardShell } from "./ToolCardShell";

/** task tool: the agent tree this tool call spawned (scoped by parentToolCallId), in a
 *  remembered order (createStableSubagentOrder). Rows open the agent pane; the header totals the whole fan-out. */
export const TaskToolCard: Component<{ item: ToolItem }> = (props) => {
	const description = () => {
		const args = props.item.args as { description?: string; task?: string; prompt?: string } | null;
		return args?.description ?? args?.task ?? args?.prompt ?? "";
	};
	const order = createStableSubagentOrder();
	const forest = createMemo(() => order(subagentTree(props.item.toolCallId)));
	return (
		<ToolCardShell
			name="task"
			arg={description()}
			status={effectiveStatus(props.item)}
			background={props.item.background}
			class="task-tool"
			meta={
				<Show when={forest().length > 0}>
					<SubagentFanoutTotals totals={fanoutTotals(props.item.toolCallId)} placement="header" />
				</Show>
			}
		>
			<Show when={forest().length > 0}>
				<SubagentTree nodes={forest()} label="Agents spawned by this task" onOpen={openAgent} />
			</Show>
		</ToolCardShell>
	);
};
