import { Show, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";

type AskQuestion = { id?: string; question?: string; options?: { label?: string }[] };

/** ask tool: settled Q&A card — question from args, chosen answer from result. */
export const AskTool: Component<{ item: ToolItem }> = props => {
	const args = () => (props.item.args as { questions?: AskQuestion[] } | null) ?? {};
	const question = () => args().questions?.[0]?.question ?? "";
	const options = () =>
		(args().questions?.[0]?.options ?? []).map(o => o?.label ?? "").filter(Boolean) ?? [];
	const expanded = () => state.toolsExpanded || props.item.status === "running";
	const lines = () => props.item.output.split("\n");
	const shown = () => (expanded() ? lines() : lines().slice(0, 12));
	const hidden = () => Math.max(0, lines().length - 12);
	return (
		<div class="tool-card ask-tool">
			<div class="tool-header">
				<span class="tool-name">ask</span>
				<span class="tool-status" data-status={props.item.status}>
					{props.item.status}
				</span>
			</div>
			<Show when={question()}>
				<div class="ask-question">{question()}</div>
			</Show>
			<Show when={options().length > 0}>
				<div class="ask-options">{options().join(" / ")}</div>
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
