import { Show, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";

/** lsp tool: compact op summary (action/file/symbol) + capped result body. */
export const LspTool: Component<{ item: ToolItem }> = props => {
	const args = () => (props.item.args as { action?: string; file?: string; symbol?: string; query?: string } | null) ?? {};
	const action = () => args().action ?? "";
	const file = () => args().file ?? "";
	const symbol = () => args().symbol ?? "";
	const expanded = () => state.toolsExpanded || props.item.status === "running";
	const lines = () => props.item.output.split("\n");
	const shown = () => (expanded() ? lines() : lines().slice(0, 30));
	const hidden = () => Math.max(0, lines().length - 30);
	return (
		<div class="tool-card lsp-tool">
			<div class="tool-header">
				<span class="tool-name">lsp {action()}</span>
				<span class="tool-status" data-status={props.item.status}>
					{props.item.status}
				</span>
			</div>
			<Show when={file() || symbol()}>
				<div class="tool-args">
					{file() && <span class="lsp-file">{file()}</span>}
					{symbol() && <span class="lsp-symbol">{symbol()}</span>}
				</div>
			</Show>
			<Show when={props.item.output}>
				<pre class="terminal">{shown().join("\n")}</pre>
				<Show when={!expanded() && hidden() > 0}>
					<div class="tool-collapsed-note">{hidden()} hidden lines (Ctrl+O to expand)</div>
				</Show>
			</Show>
		</div>
	);
};
