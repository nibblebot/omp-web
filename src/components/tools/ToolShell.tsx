import { Show, type Component, type JSX } from "solid-js";
import { state, type ToolItem } from "../../state";

/** Lines of tool output shown while collapsed; Ctrl+O (toolsExpanded) reveals the rest. */
export const COLLAPSED_LINES = 20;

/** Cards stay expanded while running or when the user toggles Ctrl+O. */
export const toolExpanded = (item: ToolItem): boolean => state.toolsExpanded || item.status === "running";

interface ToolShellProps {
	/** Header label, rendered inside span.tool-name. */
	name: JSX.Element;
	/** Renders span.tool-status[data-status] when provided. */
	status?: string;
	/** Extra card class, e.g. "bash-tool". */
	class?: string;
	/** Extra header content after name/status (the generic card's args chip). */
	meta?: JSX.Element;
	/** Render as a <details> that stays open while running (GenericToolCard). */
	collapsible?: boolean;
	children?: JSX.Element;
}

/** Shared tool card: header (name + status) plus a tool-specific body. */
export const ToolShell: Component<ToolShellProps> = props => {
	const cardClass = () => (props.class ? `tool-card ${props.class}` : "tool-card");
	const status = () => (
		<Show when={props.status}>
			<span class="tool-status" data-status={props.status}>
				{props.status}
			</span>
		</Show>
	);
	return (
		<Show
			when={props.collapsible}
			fallback={
				<div class={cardClass()}>
					<div class="tool-header">
						<span class="tool-name">{props.name}</span>
						{status()}
					</div>
					{props.children}
				</div>
			}
		>
			<details class={cardClass()} open={state.toolsExpanded || props.status === "running"}>
				<summary>
					<span class="tool-name">{props.name}</span>
					{status()}
					{props.meta}
				</summary>
				{props.children}
			</details>
		</Show>
	);
};

interface CollapsiblePreProps {
	item: ToolItem;
	/** Raw tool output; nothing renders while empty. */
	output: string;
	/** Lines shown while collapsed. */
	maxLines?: number;
	/** Keep the LAST N lines (terminal-style tail) instead of the first N. */
	tail?: boolean;
}

/** Terminal output body with the shared "N hidden lines (Ctrl+O to expand)" tail. */
export const CollapsiblePre: Component<CollapsiblePreProps> = props => {
	const max = () => props.maxLines ?? COLLAPSED_LINES;
	const expanded = () => toolExpanded(props.item);
	const lines = () => props.output.split("\n");
	const shown = () => (expanded() ? lines() : props.tail ? lines().slice(-max()) : lines().slice(0, max()));
	const hidden = () => Math.max(0, lines().length - max());
	return (
		<Show when={props.output}>
			<pre class="terminal">{shown().join("\n")}</pre>
			<Show when={!expanded() && hidden() > 0}>
				<div class="tool-collapsed-note">{hidden()} hidden lines (Ctrl+O to expand)</div>
			</Show>
		</Show>
	);
};
