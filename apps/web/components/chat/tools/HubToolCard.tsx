import { Show, type Component } from "solid-js";
import { ArrowRightIcon } from "../../ui/icons";
import type { ToolItem } from "../../../state";
import { CollapsibleOutput, ToolCardShell } from "./ToolCardShell";

/** hub tool: send/wait/poll card showing peer, message preview, and status. */
export const HubToolCard: Component<{ item: ToolItem }> = (props) => {
	const args = () =>
		(props.item.args as {
			op?: string;
			to?: string;
			from?: string;
			message?: string;
			name?: string;
		} | null) ?? {};
	const op = () => args().op ?? "";
	const to = () => args().to ?? "";
	const from = () => args().from ?? "";
	const message = () => args().message ?? "";
	const name = () => args().name ?? "";
	const target = () => to() || from() || name() || "";
	const preview = () => message().split("\n")[0].slice(0, 140);
	return (
		<ToolCardShell name="hub" arg={op()} status={props.item.status} class="hub-tool">
			<Show when={target()}>
				<div class="tool-meta">
					{to() ? (
						<>
							<ArrowRightIcon /> {target()}
						</>
					) : (
						target()
					)}
				</div>
			</Show>
			<Show when={preview()}>
				<div class="hub-message">"{preview()}"</div>
			</Show>
			<CollapsibleOutput item={props.item} output={props.item.output} />
		</ToolCardShell>
	);
};
