import { For, Show, type Component } from "solid-js";
import { COLLAPSED_LINES, ToolShell, toolExpanded } from "./ToolShell";
import { state, type ToolItem } from "../../state";

const NUMBERED = /^\s*\d+\s*[→|:]\s?/;

/** Read tool: path header, numbered body; reuses the tool's own line numbers when present. */
export const ReadTool: Component<{ item: ToolItem }> = props => {
	const path = () => (props.item.args as { path?: string } | null)?.path ?? "";
	const offset = () => (props.item.args as { offset?: number } | null)?.offset ?? 1;
	const expanded = () => toolExpanded(props.item);

	const lines = () => {
		const raw = props.item.output.split("\n");
		const nonEmpty = raw.filter(l => l.trim().length > 0);
		const numbered = nonEmpty.length > 0 && nonEmpty.filter(l => NUMBERED.test(l)).length / nonEmpty.length > 0.6;
		return raw.map(l => (numbered ? l.replace(NUMBERED, "") : l));
	};
	const shown = () => (expanded() ? lines() : lines().slice(0, COLLAPSED_LINES));
	const startNo = () => {
		if (!props.item.output) return offset();
		const m = /^\s*(\d+)\s*[→|:]/.exec(props.item.output);
		return m ? Number(m[1]) : offset();
	};

	return (
		<ToolShell name={<>read {path()}</>} status={props.item.status} class="read-tool">
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
					<Show when={!expanded() && lines().length > COLLAPSED_LINES}>
						<div class="tool-collapsed-note">{lines().length - COLLAPSED_LINES} more lines (Ctrl+O to expand)</div>
					</Show>
				</div>
			</Show>
		</ToolShell>
	);
};
