import { Show, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";
import { ImageScan } from "./ImageScan";

/** eval tool: language + code header, streaming output pre, display images. */
export const EvalTool: Component<{ item: ToolItem }> = props => {
	const args = () => (props.item.args as { code?: string; language?: string } | null) ?? {};
	const code = () => args().code ?? "";
	const language = () => args().language ?? "";
	const expanded = () => state.toolsExpanded || props.item.status === "running";
	const lines = () => props.item.output.split("\n");
	const hidden = () => Math.max(0, lines().length - 5);
	return (
		<div class="tool-card bash-tool">
			<div class="tool-header">
				<span class="tool-name">{language() ? `eval (${language()})` : "eval"}</span>
				<span class="tool-status" data-status={props.item.status}>
					{props.item.status}
				</span>
			</div>
			<Show when={code()}>
				<pre class="terminal eval-code">{code()}</pre>
			</Show>
			<Show when={props.item.output}>
				<pre class="terminal">{expanded() ? props.item.output : lines().slice(-5).join("\n")}</pre>
				<Show when={!expanded() && hidden() > 0}>
					<div class="tool-collapsed-note">{hidden()} hidden lines (Ctrl+O to expand)</div>
				</Show>
			</Show>
			<ImageScan images={props.item.images} />
		</div>
	);
};
