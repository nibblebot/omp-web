import { Show, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";

/** Bash tool: `$ command` header, terminal body, collapsed tail when settled. */
export const BashTool: Component<{ item: ToolItem }> = props => {
	const command = () => (props.item.args as { command?: string } | null)?.command ?? "";
	const expanded = () => state.toolsExpanded || props.item.status === "running";
	const lines = () => props.item.output.split("\n");
	const hidden = () => Math.max(0, lines().length - 5);
	return (
		<div class="tool-card bash-tool">
			<div class="tool-header">
				<span class="tool-name">$ {command()}</span>
				<span class="tool-status" data-status={props.item.status}>
					{props.item.status}
				</span>
			</div>
			<Show when={props.item.output}>
				<pre class="terminal">{expanded() ? props.item.output : lines().slice(-5).join("\n")}</pre>
				<Show when={!expanded() && hidden() > 0}>
					<div class="tool-collapsed-note">{hidden()} hidden lines (Ctrl+O to expand)</div>
				</Show>
			</Show>
		</div>
	);
};
