import { Show, type Component } from "solid-js";
import type { ToolItem } from "../../state";
import { CollapsiblePre, ToolShell } from "./ToolShell";

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
	return (
		<ToolShell name={<>hub {op()}</>} status={props.item.status} class="hub-tool">
			<Show when={target()}>
				<div class="tool-meta">{to() ? `→ ${target()}` : target()}</div>
			</Show>
			<Show when={preview()}>
				<div class="hub-message">"{preview()}"</div>
			</Show>
			<CollapsiblePre item={props.item} output={props.item.output} />
		</ToolShell>
	);
};
