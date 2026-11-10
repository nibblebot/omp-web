import { createSignal, For, Show, type Component } from "solid-js";
import { pushNotice, type ChatItem } from "../../../../state";
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
import { openRewindPicker, runTurnAction, type TurnRef } from "../../../../store/graph";
import { CopyButton } from "../../../ui/CopyButton";
import { RefreshIcon, ResetIcon } from "../../../ui/icons";
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
 *  `display.hideThinkingBlock` omits thinking the same way. With
 *  `turnActions` (the session's own transcript), an answer with a message
 *  timestamp offers Retry turn (resends the last prompt before it) and
 *  Rewind to here… beside its copy button. */
export const AssistantCard: Component<{
	assistant: Extract<ChatItem, { kind: "assistant" }>;
	thinking: boolean;
	/** Per-turn display metadata (turn time, cache miss) from buildTurnMeta. */
	meta?: TurnMeta;
	turnActions?: boolean;
}> = (props) => {
	const blocks = () =>
		props.thinking && !hideThinkingBlock()
			? props.assistant.blocks
			: props.assistant.blocks.filter((b) => b.kind !== "thinking");
	const text = () => blocks().filter((b) => b.kind === "text");
	// Reactive: a tool run can consume the message after the card first drew.
	const empty = () => !props.thinking && isProseless(props.assistant);
	const turn = (): TurnRef | undefined =>
		props.turnActions && props.assistant.timestamp !== undefined
			? { role: "assistant", at: props.assistant.timestamp }
			: undefined;
	const [busy, setBusy] = createSignal(false);
	/** Run one session action at a time; failures land as an error notice. */
	const run = (action: () => Promise<void>) => {
		if (busy()) return;
		setBusy(true);
		void action()
			.catch((err) => pushNotice("error", String(err instanceof Error ? err.message : err)))
			.finally(() => setBusy(false));
	};
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
					<Show when={text().length > 0 || turn()}>
						<div class="msg-toolbar">
							<Show when={turn()}>
								{(t) => (
									<>
										<button
											type="button"
											class="msg-action-btn"
											title="Retry turn: rewind past the prompt before this answer and send it again"
											aria-label="Retry turn"
											disabled={busy()}
											onClick={() => run(() => runTurnAction("retry", t()))}
										>
											<RefreshIcon />
										</button>
										<button
											type="button"
											class="msg-action-btn"
											title="Rewind to here…: pick the point in the session tree"
											aria-label="Rewind to here…"
											disabled={busy()}
											onClick={() => run(() => openRewindPicker(t()))}
										>
											<ResetIcon />
										</button>
									</>
								)}
							</Show>
							<Show when={text().length > 0}>
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
							</Show>
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
