import { Show, type Component } from "solid-js";
import { CornerDownRightIcon } from "../../ui/icons";
import type { ToolItem } from "../../../state";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/** lsp tool: compact op summary (action/file/symbol) + capped result body. */
export const LspToolCard: Component<{ item: ToolItem }> = (props) => {
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
		<ToolCardShell name="lsp" arg={action()} status={props.item.status} class="lsp-tool">
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
			<CollapsibleOutput item={props.item} output={props.item.output} />
		</ToolCardShell>
	);
};
