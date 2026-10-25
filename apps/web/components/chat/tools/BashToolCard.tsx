import type { Component } from "solid-js";
import { effectiveStatus } from "../../../chat/background-job";
import type { ToolItem } from "../../../state";
import { ShellCommand } from "./ShellCommand";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/** Bash tool: the `$ command` header wraps to show the whole command (row-capped), output below. */
export const BashToolCard: Component<{ item: ToolItem }> = (props) => (
	<ToolCardShell
		name="bash"
		title={
			<ShellCommand
				// "…" while the command is still streaming in, as the TUI shows it.
				command={(props.item.args as { command?: string } | null)?.command || "…"}
				lang="bash"
			/>
		}
		status={effectiveStatus(props.item)}
		background={props.item.background}
		class="bash-tool"
	>
		<CollapsibleOutput item={props.item} output={props.item.output} tail />
	</ToolCardShell>
);
