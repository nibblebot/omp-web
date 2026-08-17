import type { Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { argsSummary, type ToolItem } from "../state";
import { GenericToolCard } from "./tools/GenericToolCard";
import { RENDERERS } from "./tools";

/** Dispatcher: per-tool renderer when registered, generic card otherwise. */
export const ToolCard: Component<{ item: ToolItem }> = (props) => (
	<Dynamic component={RENDERERS[props.item.name] ?? GenericToolCard} item={props.item} />
);

/** Compact one-row chip for collapsed tool cards; shows name, status, args. */
export const ToolStripCard: Component<{ item: ToolItem }> = (props) => (
	<div
		class="tool-chip"
		title={`${props.item.name} · ${props.item.status} · ${argsSummary(props.item.args)}`}
	>
		<span class="tool-name">{props.item.name}</span>
		<span class="tool-status" data-status={props.item.status}>
			{props.item.status}
		</span>
		<span class="tool-chip-args">{argsSummary(props.item.args)}</span>
	</div>
);
