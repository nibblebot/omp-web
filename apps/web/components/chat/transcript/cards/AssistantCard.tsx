import { For, Show, type Component } from "solid-js";
import type { ChatItem } from "../../../../state";
import {
	expandThinkingBlocks,
	hideThinkingBlock,
	proseOnlyThinking,
	showTokenUsage,
} from "../../../../chat/display-prefs";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../../../../chat/thinking";
import type { TurnMeta } from "../../../../chat/turn-usage";
import { formatTokens } from "../../../../usage/context";
import { buildUsageRow, formatDurationMs, formatUsageRow } from "../../../../usage/usage";
import { CopyButton } from "../../../ui/CopyButton";
import { Markdown } from "../../../ui/Markdown";

/** Thinking text as displayed, or null when nothing displayable remains. */
function thinkingView(text: string): string | null {
	const formatted = formatThinkingForDisplay(text, proseOnlyThinking());
	return hasDisplayableThinking(text, formatted) ? formatted : null;
}

/** Assistant message card. With `thinking` false, thinking blocks are omitted
 *  and a card with no text blocks then renders nothing. `display.hideThinkingBlock`
 *  omits them the same way. */
export const AssistantCard: Component<{
	assistant: Extract<ChatItem, { kind: "assistant" }>;
	thinking: boolean;
	/** Per-turn display metadata (turn time, cache miss) from buildTurnMeta. */
	meta?: TurnMeta;
}> = (props) => {
	const blocks = () =>
		props.thinking && !hideThinkingBlock()
			? props.assistant.blocks
			: props.assistant.blocks.filter((b) => b.kind !== "thinking");
	const text = () => blocks().filter((b) => b.kind === "text");
	if (!props.thinking && text().length === 0 && !props.assistant.interrupted) return null;
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
						<Show when={thinkingView(block.text)} keyed>
							{(formatted) => (
								<details class="thinking-block" open={expandThinkingBlocks()}>
									<summary>thinking</summary>
									<Markdown src={formatted} />
								</details>
							)}
						</Show>
					) : (
						<Markdown src={block.text} />
					)
				}
			</For>
			<Show when={props.assistant.interrupted}>
				<div class="interrupted-footer" role="status">
					Interrupted
				</div>
			</Show>
			<Show when={props.meta?.cacheMissTokens}>
				{(tokens) => (
					<div
						class="cache-miss-marker"
						title="The prompt cache went cold this turn; the prefix was re-processed"
					>
						⊘ cache miss · {formatTokens(tokens())} tokens
					</div>
				)}
			</Show>
			<Show when={showTokenUsage() && props.assistant.usage}>
				{(u) => {
					const row = buildUsageRow(u(), props.assistant.ttft, props.assistant.duration);
					if (!row) return null;
					const turn = props.meta?.turnMs;
					const summary = [
						turn !== undefined ? `Δ ${formatDurationMs(turn)}` : null,
						formatUsageRow(row),
					]
						.filter((part) => part !== null)
						.join(" · ");
					return (
						<div class="usage-row" title="per-turn usage">
							{summary}
						</div>
					);
				}}
			</Show>
		</div>
	);
};
