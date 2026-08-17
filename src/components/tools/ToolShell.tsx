import { createSignal, For, Show, type Component, type JSX } from "solid-js";
import { state, type ToolItem } from "../../state";

/** Lines of tool output shown while collapsed; Ctrl+O (toolsExpanded) reveals the rest. */
export const COLLAPSED_LINES = 20;

/** Lines of a write tool's new-file content shown while collapsed (Ctrl+O reveals the full file). */
export const WRITE_PREVIEW_LINES = 200;

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
export const ToolShell: Component<ToolShellProps> = (props) => {
	// User intent for the <details> toggle. The reactive default (Ctrl+O /
	// running status) must not re-assert the open attribute after the user
	// has toggled a card by hand, so once a trusted toggle event fires, the
	// resulting state wins from then on.
	const [userOpen, setUserOpen] = createSignal<boolean | null>(null);
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
						{props.meta}
					</div>
					{props.children}
				</div>
			}
		>
			<details
				class={cardClass()}
				open={userOpen() ?? (state.toolsExpanded || props.status === "running")}
				onToggle={(e) => {
					if (e.isTrusted) setUserOpen(e.currentTarget.open);
				}}
			>
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
	/** Render numbered .write-line rows (read/write cards) instead of a bare <pre>. */
	numbered?: boolean;
	/** First line number when numbered (default 1). */
	startNo?: number;
}

/** Terminal output body with the shared "N hidden lines (Ctrl+O to expand)" tail. */
export const CollapsiblePre: Component<CollapsiblePreProps> = (props) => {
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
