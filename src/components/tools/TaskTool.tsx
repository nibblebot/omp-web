import { For, Show, type Component } from "solid-js";
import { state, type SubagentInfo, type ToolItem } from "../../state";
import { ToolShell } from "./ToolShell";

export const STATUS_GLYPH: Record<string, string> = {
	started: "◐",
	running: "◐",
	completed: "✓",
	done: "✓",
	failed: "✗",
	error: "✗",
	aborted: "⊘",
};

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

/** task tool: spawned-agent list fed by the subagent frame subscription. */
export const TaskTool: Component<{ item: ToolItem }> = props => {
	const description = () => {
		const args = props.item.args as { description?: string; task?: string; prompt?: string } | null;
		return args?.description ?? args?.task ?? args?.prompt ?? "";
	};
	const subs = () => [...state.subagents.values()].sort((a, b) => a.index - b.index);
	return (
		<ToolShell name={<>task {description()}</>} status={props.item.status} class="task-tool">
			<Show when={subs().length > 0}>
				<div class="subagent-list">
					<For each={subs()}>{sub => <SubagentRow sub={sub} />}</For>
				</div>
			</Show>
		</ToolShell>
	);
};
