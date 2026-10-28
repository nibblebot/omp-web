import { For, Show, type Component } from "solid-js";
import type { ChatItem } from "../../../../state";
import {
	expandThinkingBlocks,
	hideThinkingBlock,
	proseOnlyThinking,
	showTokenUsage,
} from "../../../../chat/display-prefs";
import { isProseless } from "../../../../chat/tool-runs";
import { formatThinkingForDisplay, hasDisplayableThinking } from "../../../../chat/thinking";
import type { TurnMeta } from "../../../../chat/turn-usage";
import { formatTokens } from "../../../../usage/context";
import {
	buildUsageRow,
	formatDurationMs,
	formatTurnStamp,
	formatUsageRow,
} from "../../../../usage/usage";
import { CopyButton } from "../../../ui/CopyButton";
import { createLazyOpen } from "../../../ui/lazy-open";
import { Markdown } from "../../../ui/Markdown";

/** Thinking text as displayed, or null when nothing displayable remains. */
export function thinkingView(text: string): string | null {
	const formatted = formatThinkingForDisplay(text, proseOnlyThinking());
	return hasDisplayableThinking(text, formatted) ? formatted : null;
}

/** Assistant message card. With `thinking` false (a tool run consumed the
 *  message), thinking blocks are omitted and a card without prose or an
 *  interruption footer renders nothing at all, stats footer included.
 *  `display.hideThinkingBlock` omits thinking the same way. */
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
	// Reactive: a tool run can consume the message after the card first drew.
	const empty = () => !props.thinking && isProseless(props.assistant);
	return (
		<Show when={!empty()}>
			<div class="msg-assistant">
				<For each={blocks()}>
					{(block) =>
						block.kind === "thinking" ? (
							<Show when={thinkingView(block.text)} keyed>
								{(formatted) => {
									// A collapsed thinking block renders its text on first open.
									const { opened, onToggle, onClick } = createLazyOpen(expandThinkingBlocks());
									return (
										<details
											class="thinking-block"
											open={expandThinkingBlocks()}
											onToggle={onToggle}
											onClick={onClick}
										>
											<summary>thinking</summary>
											<Show when={opened()}>
												<Markdown src={formatted} />
											</Show>
										</details>
									);
								}}
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
				<div class="msg-footer" data-copy-feedback-bounds>
					<Show when={text().length > 0}>
						<div class="msg-toolbar">
							<CopyButton
								class="msg-copy-btn msg-copy-btn--icon"
								title="Copy message markdown"
								icon
								copiedLabel="Message copied"
								text={() =>
									text()
										.map((b) => b.text)
										.join("\n\n")
								}
							/>
						</div>
					</Show>
					<Show when={showTokenUsage() && props.assistant.usage}>
						{(u) => {
							const row = buildUsageRow(u(), props.assistant.ttft, props.assistant.duration);
							if (!row) return null;
							const turn = props.meta?.turnMs;
							const at = props.assistant.completedAt;
							const summary = [
								at !== undefined ? formatTurnStamp(at, Date.now()) : null,
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
			</div>
		</Show>
	);
};
