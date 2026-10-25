import type { Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ToolItem } from "../../../state";
import { GenericToolCard } from "./GenericToolCard";
import { RENDERERS } from "./renderers";
import { ToolCallIdContext } from "./ToolCardShell";

/** Dispatcher: per-tool renderer when registered, generic card otherwise; the card root carries the call's id for jumps (`ToolCallIdContext`). */
export const ToolCard: Component<{ item: ToolItem }> = (props) => (
	<ToolCallIdContext.Provider value={props.item.toolCallId}>
		<Dynamic component={RENDERERS[props.item.name] ?? GenericToolCard} item={props.item} />
	</ToolCallIdContext.Provider>
);
