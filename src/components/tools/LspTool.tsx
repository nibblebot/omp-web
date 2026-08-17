import { Show, type Component } from "solid-js";
import { CornerDownRightIcon } from "../../icons";
import type { ToolItem } from "../../state";
import { CollapsiblePre, ToolShell } from "./ToolShell";

/** lsp tool: compact op summary (action/file/symbol) + capped result body. */
export const LspTool: Component<{ item: ToolItem }> = (props) => {
	const args = () =>
		(props.item.args as {
			action?: string;
			file?: string;
			symbol?: string;
			query?: string;
		} | null) ?? {};
	const action = () => args().action ?? "";
	const file = () => args().file ?? "";
	const symbol = () => args().symbol ?? "";
	return (
		<ToolShell name={<>lsp {action()}</>} status={props.item.status} class="lsp-tool">
			<Show when={file() || symbol()}>
				<div class="tool-meta">
					{file() && <span class="lsp-file">{file()}</span>}
					{symbol() && (
						<span class="lsp-symbol">
							<CornerDownRightIcon class="lsp-symbol-icon" />
							{symbol()}
						</span>
					)}
				</div>
			</Show>
			<CollapsiblePre item={props.item} output={props.item.output} />
		</ToolShell>
	);
};
