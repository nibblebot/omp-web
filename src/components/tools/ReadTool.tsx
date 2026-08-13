import { Show, type Component } from "solid-js";
import { type ToolItem } from "../../state";
import { CollapsiblePre, ToolShell } from "./ToolShell";

const NUMBERED = /^\s*\d+\s*[→|:]\s?/;

/** Read tool: path header, numbered body; reuses the tool's own line numbers when present. */
export const ReadTool: Component<{ item: ToolItem }> = props => {
	const path = () => (props.item.args as { path?: string } | null)?.path ?? "";
	const offset = () => (props.item.args as { offset?: number } | null)?.offset ?? 1;

	const lines = () => {
		const raw = props.item.output.split("\n");
		const nonEmpty = raw.filter(l => l.trim().length > 0);
		const numbered = nonEmpty.length > 0 && nonEmpty.filter(l => NUMBERED.test(l)).length / nonEmpty.length > 0.6;
		return raw.map(l => (numbered ? l.replace(NUMBERED, "") : l));
	};
	const startNo = () => {
		if (!props.item.output) return offset();
		const m = /^\s*(\d+)\s*[→|:]/.exec(props.item.output);
		return m ? Number(m[1]) : offset();
	};

	return (
		<ToolShell name={<>read {path()}</>} status={props.item.status} class="read-tool">
			<Show when={props.item.output}>
				<div class="read-body">
					<CollapsiblePre item={props.item} output={lines().join("\n")} numbered startNo={startNo()} />
				</div>
			</Show>
		</ToolShell>
	);
};
