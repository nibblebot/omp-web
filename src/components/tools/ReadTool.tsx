import { For, Show, type Component } from "solid-js";
import { state, type ToolItem } from "../../state";

const NUMBERED = /^\s*\d+\s*[→|:]\s?/;

/** Read tool: path header, numbered body; reuses the tool's own line numbers when present. */
export const ReadTool: Component<{ item: ToolItem }> = props => {
	const path = () => (props.item.args as { path?: string } | null)?.path ?? "";
	const offset = () => (props.item.args as { offset?: number } | null)?.offset ?? 1;
	const expanded = () => state.toolsExpanded || props.item.status === "running";

	const lines = () => {
		const raw = props.item.output.split("\n");
		const nonEmpty = raw.filter(l => l.trim().length > 0);
		const numbered = nonEmpty.length > 0 && nonEmpty.filter(l => NUMBERED.test(l)).length / nonEmpty.length > 0.6;
		return raw.map(l => (numbered ? l.replace(NUMBERED, "") : l));
	};
	const shown = () => (expanded() ? lines() : lines().slice(0, 20));
	const startNo = () => {
		if (!props.item.output) return offset();
		const m = /^\s*(\d+)\s*[→|:]/.exec(props.item.output);
		return m ? Number(m[1]) : offset();
	};

	return (
		<div class="tool-card read-tool">
			<div class="tool-header">
				<span class="tool-name">read {path()}</span>
				<span class="tool-status" data-status={props.item.status}>
					{props.item.status}
				</span>
			</div>
			<Show when={props.item.output}>
				<div class="read-body">
					<For each={shown()}>
						{(line, i) => (
							<div class="write-line">
								<span class="line-no">{startNo() + i()}</span>
								{line}
							</div>
						)}
					</For>
					<Show when={!expanded() && lines().length > 20}>
						<div class="tool-collapsed-note">{lines().length - 20} more lines (Ctrl+O to expand)</div>
					</Show>
				</div>
			</Show>
		</div>
	);
};
