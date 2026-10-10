import type { Component } from "solid-js";
import { argsSummary, type ToolItem } from "../../../state";
import { ImageThumbnails } from "../../ui/ImageThumbnails";
import { ToolCardShell } from "./ToolCardShell";

// Deliberately generic: one <details>/<pre> card for every unrecognized tool.
export const GenericToolCard: Component<{ item: ToolItem }> = (props) => (
	<ToolCardShell
		name={props.item.name}
		status={props.item.status}
		meta={<span class="tool-args">{argsSummary(props.item.args).slice(0, 120)}</span>}
		collapsible
	>
		<pre>{props.item.output}</pre>
		<ImageThumbnails images={props.item.images} />
	</ToolCardShell>
);
