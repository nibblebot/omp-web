import type { Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { ToolItem } from "../../../state";
import { GenericToolCard } from "./GenericToolCard";
import { RENDERERS } from "./renderers";

/** Dispatcher: per-tool renderer when registered, generic card otherwise. */
export const ToolCard: Component<{ item: ToolItem }> = (props) => (
	<Dynamic component={RENDERERS[props.item.name] ?? GenericToolCard} item={props.item} />
);
