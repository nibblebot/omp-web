import { createMemo, Show, type Component } from "solid-js";
import { effectiveStatus } from "../../../chat/background-job";
import type { ToolItem } from "../../../state";
import { openActivities } from "../../../store/activities";
import { fanoutTotals, subagentTree } from "../../../store/subagents";
import { SubagentFanoutTotals } from "../../subagents/SubagentFanoutTotals";
import { SubagentTree } from "../../subagents/SubagentTree";
import { createStableSubagentOrder } from "../../../subagents/tree";
import { ToolCardShell } from "./ToolCardShell";

/** task tool: the agent tree this tool call spawned (scoped by parentToolCallId), in a
 *  remembered order (createStableSubagentOrder). Rows open the agent pane; the header totals the whole fan-out. */
export const TaskToolCard: Component<{ item: ToolItem }> = (props) => {
	const description = () => {
		const args = props.item.args as {
			description?: string;
			task?: string;
			taskFile?: string;
			prompt?: string;
		} | null;
		// `task.file` replaces `task` with `taskFile` (a path) on a call.
		return args?.description ?? args?.task ?? args?.taskFile ?? args?.prompt ?? "";
	};
	const order = createStableSubagentOrder();
	// One evaluation per forest build, shared by every read below; a card whose agents did not change gets
	// the same arrays back and updates nothing.
	const forest = createMemo(() => order(subagentTree(props.item.toolCallId)));
	const totals = createMemo(() => fanoutTotals(props.item.toolCallId));
	return (
		<ToolCardShell
			name="task"
			arg={description()}
			status={effectiveStatus(props.item)}
			background={props.item.background}
			class="task-tool"
			meta={
				<Show when={forest().length > 0}>
					<SubagentFanoutTotals totals={totals()} placement="header" />
				</Show>
			}
		>
			<Show when={forest().length > 0}>
				<SubagentTree
					nodes={forest()}
					label="Agents spawned by this task"
					onOpen={(id) => openActivities({ item: { section: "subagents", id } })}
				/>
			</Show>
		</ToolCardShell>
	);
};
