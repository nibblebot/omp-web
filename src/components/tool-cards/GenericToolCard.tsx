import type { Component } from "solid-js";
import { argsSummary, type ToolItem } from "../../state";
import { ImageScan } from "../shared/ImageScan";
import { ToolShell } from "./ToolShell";

// Deliberately generic: one <details>/<pre> card for every unrecognized tool.
export const GenericToolCard: Component<{ item: ToolItem }> = (props) => (
	<ToolShell
		name={props.item.name}
		status={props.item.status}
		meta={<span class="tool-args">{argsSummary(props.item.args).slice(0, 120)}</span>}
		collapsible
	>
		<pre>{props.item.output}</pre>
		<ImageScan images={props.item.images} />
	</ToolShell>
);
