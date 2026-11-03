import { Show, type Component } from "solid-js";
import { effectiveStatus } from "../../../chat/background-job";
import { minimizedSummary } from "../../../chat/bash-minimized";
import type { ToolItem } from "../../../state";
import { ShellCommand } from "./ShellCommand";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/**
 * Bash tool: the `$ command` header wraps to show the whole command (row-capped), output below.
 * When the SDK's output minimizer rewrote the result, a Minimized fact names the filter and the
 * bytes before and after.
 */
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
		<Show when={minimizedSummary(props.item.details)}>
			{(summary) => <div class="tool-meta">Minimized: {summary()}</div>}
		</Show>
	</ToolCardShell>
);
