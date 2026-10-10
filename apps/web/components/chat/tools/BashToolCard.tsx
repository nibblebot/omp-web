import type { Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/** Bash tool: `$ command` header, terminal body, collapsed tail when settled. */
export const BashToolCard: Component<{ item: ToolItem }> = (props) => {
	const command = () => (props.item.args as { command?: string } | null)?.command ?? "";
	return (
		<ToolCardShell
			name={<span class="bash-cmd">$ {command()}</span>}
			status={props.item.status}
			class="bash-tool"
		>
			<CollapsibleOutput item={props.item} output={props.item.output} tail />
		</ToolCardShell>
	);
};
