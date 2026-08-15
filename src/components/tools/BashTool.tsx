import type { Component } from "solid-js";
import type { ToolItem } from "../../state";
import { CollapsiblePre, ToolShell } from "./ToolShell";

/** Bash tool: `$ command` header, terminal body, collapsed tail when settled. */
export const BashTool: Component<{ item: ToolItem }> = props => {
	const command = () => (props.item.args as { command?: string } | null)?.command ?? "";
	return (
		<ToolShell name={<span class="bash-cmd">$ {command()}</span>} status={props.item.status} class="bash-tool">
			<CollapsiblePre item={props.item} output={props.item.output} tail />
		</ToolShell>
	);
};
