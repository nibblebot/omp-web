import { createMemo, For, Match, Show, Switch, type Component } from "solid-js";
import { characterForModel } from "../../../sprites/characters";
import { openLightbox, state } from "../../../state";
import { ArrowDownIcon } from "../../ui/icons";
import { CharacterAvatar } from "../../models/CharacterAvatar";
import { ToolCard } from "../tools/ToolCard";
import {
	cacheMissMarker,
	hideThinkingBlock,
	hideToolActivity,
	shimmerMode,
	showTokenUsage,
	showTurnTime,
} from "../../../chat/display-prefs";
import { buildTurnMeta } from "../../../chat/turn-usage";
import { useStickyScroll } from "./useStickyScroll";
import { StreamingBlock } from "./StreamingBlock";
import { featureTranscriptCard } from "../../../features/registry";
import {
	AssistantCard,
	CompactionCard,
	GuestPromptCard,
	NoticeCard,
	UserCard,
	UserCommandCard,
} from "./cards";

/** Empty-transcript state: large character sprite and a one-line greeting.
 *  Held blank until the loaded transcript's state frame lands (modelSynced):
 *  history primes before state, so rendering earlier would flash the
 *  previous session's (or the fallback) character. */
const EmptyState: Component = () => (
	<div class="chat-transcript-empty">
		<Show when={state.modelSynced}>
			<CharacterAvatar
				provider={state.model?.provider}
				id={state.model?.id}
				pose="happy"
				size={96}
			/>
			<p class="chat-transcript-empty-greeting">
				{characterForModel(state.model?.provider, state.model?.id).name} is ready. What should we
				work on?
			</p>
		</Show>
	</div>
);

/** Scroller for a non-empty transcript. Owns useStickyScroll, so the
 *  hook's setup and onMount run when the list mounts (first item or live turn). */
const TranscriptList: Component = () => {
	const { containerRef, contentRef, jumpVisible, jumpToBottom } = useStickyScroll();
	// Per-assistant turn metadata (turn time, cache miss). Computed only for the
	// toggles that are on, so the items scan is skipped when both are off.
	const turnMeta = createMemo(() =>
		buildTurnMeta(state.items, {
			turnTime: showTokenUsage() && showTurnTime(),
			cacheMiss: cacheMissMarker(),
		}),
	);
	return (
		<>
			<div class="chat-transcript-wrap">
				<div class="chat-transcript" ref={containerRef}>
					{/* Observed by useStickyScroll's ResizeObserver: any growth here
					    (streamed text, tool output, mode switches, run toggles, image
					    decodes) re-pins a pinned viewport. The zoom overlay stays
					    outside since it's position:fixed and must not count as content. */}
					<div class="chat-transcript-content" ref={contentRef}>
						<For each={state.items}>
							{(item) => (
								<Switch>
									<Match when={item.kind === "user" && item}>
										{(user) => <UserCard user={user()} onZoom={openLightbox} />}
									</Match>
									<Match when={item.kind === "assistant" && item}>
										{(assistant) => (
											<AssistantCard
												assistant={assistant()}
												thinking
												meta={turnMeta().get(assistant().id)}
											/>
										)}
									</Match>
									<Match when={item.kind === "tool" && !hideToolActivity() && item}>
										{(tool) => <ToolCard item={tool()} />}
									</Match>
									<Match when={item.kind === "bash" && item}>
										{(bash) => <UserCommandCard item={bash()} />}
									</Match>
									<Match when={item.kind === "compaction" && item}>
										{(c) => <CompactionCard item={c()} />}
									</Match>
									<Match when={item.kind === "advisor" && item}>
										{(a) => (
											<Show when={featureTranscriptCard("advisor")} keyed>
												{(Card) => <Card item={a()} />}
											</Show>
										)}
									</Match>
									<Match when={item.kind === "guestPrompt" && item}>
										{(guest) => <GuestPromptCard item={guest()} />}
									</Match>
									<Match when={item.kind === "notice" && item}>
										{(notice) => <NoticeCard item={notice()} />}
									</Match>
								</Switch>
							)}
						</For>
						<Show when={state.live.active}>
							<div class="msg-assistant live">
								<For each={state.live.blocks}>
									{(block) =>
										block.kind === "thinking" ? (
											<Show when={!hideThinkingBlock()}>
												<details class="thinking-block" open>
													<summary>thinking</summary>
													<StreamingBlock block={block} proseOnly />
												</details>
											</Show>
										) : (
											<StreamingBlock block={block} />
										)
									}
								</For>
							</div>
						</Show>
						{/* In-progress shimmer: spans the whole agent turn (tool gaps included),
			    not just the live message card. Label tracks the latest tool-call
			    intent like the TUI working message; the TUI's default phrase
			    ("Working…") applies until the first intent lands. */}
						<Show when={state.streaming}>
							<div class="live-shimmer" data-shimmer={shimmerMode()} aria-hidden="true">
								<span class="shimmer-text">{state.workingIntent ?? "Working…"}</span>
							</div>
						</Show>
					</div>
				</div>
				{/* Floated over the stream's lower-right while unpinned; one click
			    re-pins and lands at the live edge. */}
				<Show when={jumpVisible()}>
					<button
						class="jump-to-bottom"
						onClick={jumpToBottom}
						title="Jump to bottom"
						aria-label="Jump to bottom"
					>
						<ArrowDownIcon />
					</button>
				</Show>
			</div>
		</>
	);
};

/**
 * The session transcript: the sticky-scrolling message stream. Shows the
 * greeting empty state while there are no items and no live turn.
 */
export const Transcript: Component = () => (
	<Show when={state.items.length > 0 || state.live.active} fallback={<EmptyState />}>
		<TranscriptList />
	</Show>
);
