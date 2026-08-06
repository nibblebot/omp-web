import { Show, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";

/** hub tool: send/wait/poll card — peer, message preview, status. */
export const HubTool: Component<{ item: ToolItem }> = props => {
	const args = () =>
		(props.item.args as { op?: string; to?: string; from?: string; message?: string; name?: string } | null) ?? {};
	const op = () => args().op ?? "";
	const to = () => args().to ?? "";
	const from = () => args().from ?? "";
	const message = () => args().message ?? "";
	const name = () => args().name ?? "";
	const target = () => to() || from() || name() || "";
	const preview = () => message().split("\n")[0].slice(0, 140);
	const expanded = () => state.toolsExpanded || props.item.status === "running";
	const lines = () => props.item.output.split("\n");
	const shown = () => (expanded() ? lines() : lines().slice(0, 20));
	const hidden = () => Math.max(0, lines().length - 20);
	return (
		<div class="tool-card hub-tool">
			<div class="tool-header">
				<span class="tool-name">hub {op()}</span>
				<span class="tool-status" data-status={props.item.status}>
					{props.item.status}
				</span>
			</div>
			<Show when={target()}>
				<div class="tool-args">{to() ? `→ ${target()}` : target()}</div>
			</Show>
			<Show when={preview()}>
				<div class="hub-message">"{preview()}"</div>
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
