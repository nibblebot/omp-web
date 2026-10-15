import { Show, type Component } from "solid-js";
import { argsSummary, type ToolItem } from "../../../state";
import { settingValue } from "../../../store/settings";
import { ImageThumbnails } from "../../ui/ImageThumbnails";
import { Markdown } from "../../ui/Markdown";
import { ToolCardShell } from "./ToolCardShell";
import { isMarkdownMcpResult } from "./mcp-markdown";

// Deliberately generic: one <details>/<pre> card for every unrecognized tool.
// MCP text results render as Markdown under `mcp.renderMarkdownResults` (SDK default on).
export const GenericToolCard: Component<{ item: ToolItem }> = (props) => (
	<ToolCardShell
		name={props.item.name}
		status={props.item.status}
		meta={<span class="tool-args">{argsSummary(props.item.args).slice(0, 120)}</span>}
		collapsible
	>
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
