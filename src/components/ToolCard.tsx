import type { Component } from "solid-js";
import { argsSummary, type ChatItem } from "../state";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

// Deliberately generic: one <details>/<pre> card for every tool.
export const ToolCard: Component<{ item: ToolItem }> = props => (
	<details class="tool-card" open={props.item.status === "running"}>
		<summary>
			<span class="tool-name">{props.item.name}</span>
			<span class="tool-status" data-status={props.item.status}>
				{props.item.status}
			</span>
			<span class="tool-args">{argsSummary(props.item.args).slice(0, 120)}</span>
		</summary>
		<pre>{props.item.output}</pre>
	</details>
);
