import { createMemo, Show, type Component } from "solid-js";
import type { ToolItem } from "../../../state";
import { HighlightedText } from "./HighlightedText";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/** Past this length the header arg is truncated, so the full command also shows in the body. */
const HEADER_COMMAND_CHARS = 120;

/** Bash tool: highlighted first command line in the header, full command above the terminal body when it is long or multi-line. */
export const BashToolCard: Component<{ item: ToolItem }> = (props) => {
	const command = createMemo(() => (props.item.args as { command?: string } | null)?.command ?? "");
	const firstLine = createMemo(() => command().split("\n", 1)[0]!);
	const showFull = createMemo(
		() => command().includes("\n") || command().length > HEADER_COMMAND_CHARS,
	);
	return (
		<ToolCardShell
			name="bash"
			arg={firstLine() ? <HighlightedText code={firstLine()} lang="bash" /> : undefined}
			status={props.item.status}
			class="bash-tool"
		>
			<Show when={showFull()}>
				<pre class="terminal tool-code">
					<HighlightedText code={command()} lang="bash" />
				</pre>
			</Show>
			<CollapsibleOutput item={props.item} output={props.item.output} tail />
		</ToolCardShell>
	);
};
