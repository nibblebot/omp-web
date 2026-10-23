import { createMemo, Show, type Component } from "solid-js";
import { argsSummary, type ToolItem } from "../../../state";
import { settingValue } from "../../../store/settings";
import { ImageThumbnails } from "../../ui/ImageThumbnails";
import { Markdown } from "../../ui/Markdown";
import { HighlightedText } from "./HighlightedText";
import { ToolCardShell } from "./ToolCardShell";
import { isMarkdownMcpResult } from "./mcp-markdown";

// Deliberately generic: one <details>/<pre> card for every unrecognized tool.
// MCP text results render as Markdown under `mcp.renderMarkdownResults` (SDK default on).
export const GenericToolCard: Component<{ item: ToolItem }> = (props) => {
	const summary = createMemo(() => argsSummary(props.item.args).slice(0, 120));
	// Pretty-printed args for the open body; null when the call carries no args.
	const prettyArgs = createMemo(() => {
		const args = props.item.args;
		if (args === null || args === undefined) return null;
		if (typeof args === "object" && Object.keys(args).length === 0) return null;
		return JSON.stringify(args, null, 2);
	});
	return (
		<ToolCardShell
			name={props.item.name}
			arg={summary() ? <HighlightedText code={summary()} lang="json" /> : undefined}
			status={props.item.status}
			collapsible
		>
			<Show when={prettyArgs()}>
				{(json) => (
					<pre class="terminal tool-code">
						<HighlightedText code={json()} lang="json" />
					</pre>
				)}
			</Show>
			<Show
				when={
					(settingValue<boolean>("mcp.renderMarkdownResults") ?? true) &&
					isMarkdownMcpResult(props.item.name, props.item.output)
				}
				fallback={<pre>{props.item.output}</pre>}
			>
				<Markdown src={props.item.output} />
			</Show>
			<ImageThumbnails images={props.item.images} />
		</ToolCardShell>
	);
};
