import { createMemo, For, Match, Show, Switch, type Component, type JSX } from "solid-js";
import { openLightbox, state, type ChatItem } from "../../../state";
import { ArrowDownIcon } from "../../ui/icons";
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

/**
 * The sticky-scrolling message stream over one list of chat items: the same
 * cards, pin-to-bottom and jump-to-live control for the main session and for
 * a subagent. Owns useStickyScroll, so the hook's setup and onMount run when
 * the stream mounts.
 *
 * `variant` selects what is main-only. "session": the live streaming turn and
 * working shimmer, branch-from-here on user cards, and pin state mirrored into
 * the store. "agent": none of those, and the first user message (the agent's
 * assignment) is folded behind a Show all toggle. `children` render after the
 * items, inside the observed content (status lines grow the stream like items).
 */
export const TranscriptStream: Component<{
	items: readonly ChatItem[];
	variant: "session" | "agent";
	/** Extra class on the root (which fills its parent and holds the scroller). */
	class?: string;
	children?: JSX.Element;
}> = (props) => {
	const session = () => props.variant === "session";
	const { containerRef, contentRef, jumpVisible, jumpToBottom } = useStickyScroll({
		mirrorSession: session(),
	});
	// Per-assistant turn metadata (turn time, cache miss). Computed only for the
	// toggles that are on, so the items scan is skipped when both are off.
	const turnMeta = createMemo(() =>
		buildTurnMeta(props.items, {
			turnTime: showTokenUsage() && showTurnTime(),
			cacheMiss: cacheMissMarker(),
		}),
	);
	return (
		<div class={props.class ? `chat-transcript-wrap ${props.class}` : "chat-transcript-wrap"}>
			<div class="chat-transcript" ref={containerRef}>
				{/* Observed by useStickyScroll's ResizeObserver: any growth here
				    (streamed text, tool output, mode switches, run toggles, image
				    decodes) re-pins a pinned viewport. The zoom overlay stays
				    outside since it's position:fixed and must not count as content. */}
				<div class="chat-transcript-content" ref={contentRef}>
					<For each={props.items}>
						{(item, index) => (
							<Switch>
								<Match when={item.kind === "user" && item}>
									{(user) => (
										<UserCard
											user={user()}
											onZoom={openLightbox}
											branchable={session()}
											fold={!session() && index() === 0}
										/>
									)}
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
					<Show when={session() && state.live.active}>
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
					<Show when={session() && state.streaming}>
						<div class="live-shimmer" data-shimmer={shimmerMode()} aria-hidden="true">
							<span class="shimmer-text">{state.workingIntent ?? "Working…"}</span>
						</div>
					</Show>
					{props.children}
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
	);
};
