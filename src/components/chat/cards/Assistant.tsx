import { For, Show, type Component } from "solid-js";
import type { ChatItem } from "../../../state";
import { buildUsageRow, formatUsageRow } from "../../../usage";
import { CopyButton } from "../../shared/CopyButton";
import { Markdown } from "../../shared/Markdown";

/** Assistant message card. With `thinking` false, thinking blocks are omitted
 *  (consumed by a consolidated run row); a card with no text blocks then
 *  renders nothing. */
export const AssistantCard: Component<{
	assistant: Extract<ChatItem, { kind: "assistant" }>;
	thinking: boolean;
}> = (props) => {
	const blocks = () =>
		props.thinking
			? props.assistant.blocks
			: props.assistant.blocks.filter((b) => b.kind !== "thinking");
	const text = () => blocks().filter((b) => b.kind === "text");
	if (!props.thinking && text().length === 0) return null;
	return (
		<div class="msg-assistant">
			<div class="msg-toolbar">
				<CopyButton
					class="msg-copy-btn"
					title="Copy message markdown"
					text={() => {
						const visible = blocks().filter((b) => b.kind !== "thinking");
						return (visible.length > 0 ? visible : props.assistant.blocks)
							.map((b) => b.text)
							.join("\n\n");
					}}
				/>
			</div>
			<For each={blocks()}>
				{(block) =>
					block.kind === "thinking" ? (
						<details class="thinking-block">
							<summary>thinking</summary>
							<Markdown src={block.text} />
						</details>
					) : (
						<Markdown src={block.text} />
					)
				}
			</For>
			<Show when={props.assistant.usage}>
				{(u) => {
					const row = buildUsageRow(u(), props.assistant.ttft, props.assistant.duration);
					return row ? (
						<div class="usage-row" title="per-turn usage">
							{formatUsageRow(row)}
						</div>
					) : null;
				}}
			</Show>
		</div>
	);
};
