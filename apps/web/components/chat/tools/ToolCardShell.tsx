import { createEffect, createSignal, For, on, Show, type Component, type JSX } from "solid-js";
import { state, type ToolItem } from "../../../state";
import { Card } from "../../ui/Card";

/** Lines of tool output shown while collapsed; Ctrl+O (toolsExpanded) reveals the rest. */
export const COLLAPSED_LINES = 20;

/** Cards stay expanded while running or when the user toggles Ctrl+O. */
export const toolExpanded = (item: ToolItem): boolean =>
	state.toolsExpanded || item.status === "running";

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
export const ToolCardShell: Component<ToolShellProps> = (props) => {
	// User intent for the <details> toggle. A trusted toggle that differs from
	// the reactive default is a user click; the browser also fires trusted
	// toggles for our own open changes (running → done), which match the default
	// and are ignored. Ctrl+O / the header kebab clears the intent on every card.
	const [userOpen, setUserOpen] = createSignal<boolean | null>(null);
	createEffect(
		on(
			() => state.toolsExpanded,
			() => setUserOpen(null),
			{ defer: true },
		),
	);
	const cardClass = () => (props.class ? `tool-card ${props.class}` : "tool-card");
	const status = () => (
		<Show when={props.status}>
			<span class="tool-status" data-status={props.status}>
				{props.status}
			</span>
		</Show>
	);
	return (
		<Card
			class={cardClass()}
			collapsible={props.collapsible}
			open={userOpen() ?? (state.toolsExpanded || props.status === "running")}
			onToggle={(e) => {
				if (
					e.isTrusted &&
					e.currentTarget.open !== (state.toolsExpanded || props.status === "running")
				)
					setUserOpen(e.currentTarget.open);
			}}
			header={
				<>
					<span class="tool-name">{props.name}</span>
					{status()}
					{props.meta}
				</>
			}
		>
			{props.children}
		</Card>
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
	/** Render numbered .write-line rows (read/write cards) instead of a bare <pre>. */
	numbered?: boolean;
	/** First line number when numbered (default 1). */
	startNo?: number;
}

/** Terminal output body with the shared "N hidden lines (Ctrl+O to expand)" tail. */
export const CollapsibleOutput: Component<CollapsiblePreProps> = (props) => {
	const max = () => props.maxLines ?? COLLAPSED_LINES;
	const expanded = () => toolExpanded(props.item);
	const lines = () => props.output.split("\n");
	const shown = () =>
		expanded() ? lines() : props.tail ? lines().slice(-max()) : lines().slice(0, max());
	const hidden = () => Math.max(0, lines().length - max());
	return (
		<Show when={props.output}>
			<Show when={props.numbered} fallback={<pre class="terminal">{shown().join("\n")}</pre>}>
				<For each={shown()}>
					{(line, i) => (
						<div class="write-line">
							<span class="line-no">{(props.startNo ?? 1) + i()}</span>
							{line}
						</div>
					)}
				</For>
			</Show>
			<Show when={!expanded() && hidden() > 0}>
				<div class="tool-collapsed-note">{hidden()} hidden lines (Ctrl+O to expand)</div>
			</Show>
		</Show>
	);
};
