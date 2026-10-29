import {
	createComputed,
	createEffect,
	For,
	Match,
	on,
	onCleanup,
	onMount,
	Show,
	Switch,
	type Component,
	type JSX,
} from "solid-js";
import { openLightbox, state, type ChatItem } from "../../../state";
import { ArrowDownIcon } from "../../ui/icons";
import { ToolCard } from "../tools/ToolCard";
import { WaitToolCard } from "../tools/WaitToolCard";
import {
	cacheMissMarker,
	hideThinkingBlock,
	hideToolActivity,
	proseOnlyThinking,
	showTokenUsage,
	showTurnTime,
} from "../../../chat/display-prefs";
import {
	createTranscriptIndex,
	isRunMember,
	type ToolSlot,
	type WaitSlot,
} from "../../../chat/transcript-index";
import type { Run } from "../../../chat/tool-runs";
import type { WaitRun } from "../../../chat/wait-runs";
import { createTranscriptWindow } from "../../../chat/transcript-window";
import { registerToolReveal } from "../../../chat/tool-jump";
import {
	captureScrollAnchors,
	restoreScrollAnchor,
	type ScrollAnchor,
} from "../../../chat/scroll-anchor";
import { isActivitiesOpen } from "../../../store/activities";
import { useStickyScroll } from "./useStickyScroll";
import { StreamingBlock } from "./StreamingBlock";
import {
	AdvisorCard,
	AssistantCard,
	CompactionCard,
	GuestPromptCard,
	NoticeCard,
	ToolRunRow,
	UserCard,
	UserCommandCard,
} from "./cards";

/** How many viewports of mounted content the reader keeps above the top of the screen before older items mount. */
const LOAD_AHEAD_SCREENS = 2;

/** The run a slot holds, or undefined for a member: a run draws at its first call. */
const toolRunOf = (slot: ToolSlot): Run | undefined => (isRunMember(slot) ? undefined : slot);
const waitRunOf = (slot: WaitSlot): WaitRun | undefined => (isRunMember(slot) ? undefined : slot);

/**
 * The sticky-scrolling message stream over one list of chat items: the same
 * cards, pin-to-bottom and jump-to-live control for the main session and for
 * a subagent. Owns useStickyScroll, so the hook's setup and onMount run when
 * the stream mounts.
 *
 * `variant` selects what is main-only. "session": the live streaming turn,
 * branch-from-here on user cards, and pin state mirrored into
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
	const { containerRef, contentRef, jumpVisible, jumpToBottom, release, snapIfPinned } =
		useStickyScroll({
			mirrorSession: session(),
		});
	// What the rows ask of the whole list (tool runs, wait runs, turn metadata,
	// the cards the open Activities panel shows instead), answered per item id so
	// a row re-renders only when its own answer changes. Runs and turn metadata
	// stay computed on the full list; a subagent's own stream (inside the panel's
	// detail) keeps all its cards.
	const index = createTranscriptIndex(
		() => props.items,
		() => ({
			consolidated: state.display.toolCards === "consolidated",
			hideToolActivity: hideToolActivity(),
			hideActivityCards: session() && isActivitiesOpen(),
			hideThinking: hideThinkingBlock(),
			proseOnlyThinking: proseOnlyThinking(),
			showTokenUsage: showTokenUsage(),
			turnTime: showTokenUsage() && showTurnTime(),
			cacheMiss: cacheMissMarker(),
		}),
	);
	// Only the tail of a long transcript is mounted; older items mount as the
	// reader scrolls up.
	const win = createTranscriptWindow(() => props.items, {
		pinned: () => !jumpVisible(),
		leadOf: index.leadOf,
	});
	let scroller!: HTMLDivElement;
	let content!: HTMLDivElement;
	// The cards an unpinned viewport can be anchored to: the Show earlier row stays at the top as cards mount below it.
	const anchorRows = (): ArrayLike<Element> =>
		win.hiddenBefore() > 0 ? Array.prototype.slice.call(content.children, 1) : content.children;
	// Items mounted above the viewport keep the on-screen content where it is.
	const showEarlier = () => {
		const anchors = captureScrollAnchors(scroller, anchorRows());
		win.showEarlier();
		restoreScrollAnchor(scroller, anchors);
	};
	// Older items mount before the reader runs out of mounted content: when the
	// top of the screen is within LOAD_AHEAD_SCREENS viewports of the oldest card
	// (a pinned viewport, which is about to sit at the live edge, counts the
	// height above that edge).
	const loadEarlier = () => {
		if (win.hiddenBefore() === 0 || scroller.clientHeight === 0) return;
		const reserve = scroller.clientHeight * LOAD_AHEAD_SCREENS;
		const above = jumpVisible()
			? scroller.scrollTop
			: scroller.scrollHeight - scroller.clientHeight;
		if (above < reserve) showEarlier();
	};
	// A pinned viewport scrolls on every snap; only the reader's own scrolling can near the top.
	const onScroll = () => {
		if (jumpVisible()) loadEarlier();
	};
	onMount(() => {
		scroller.addEventListener("scroll", onScroll, { passive: true });
		onCleanup(() => scroller.removeEventListener("scroll", onScroll));
		onCleanup(
			registerToolReveal((toolCallId) => {
				const found = win.reveal((item) => item.kind === "tool" && item.toolCallId === toolCallId);
				// The jump leaves the live edge: without the release, the content the mount adds re-snaps a pinned viewport to it.
				if (found) release();
				return found;
			}),
		);
	});
	// Cards removed above a pinned viewport shrink the scroller; snap before the browser's clamp
	// scroll event reaches the unpin rule (it would read as the reader leaving the live edge).
	createEffect(on(win.hiddenBefore, snapIfPinned, { defer: true }));
	createEffect(
		on(win.hiddenBefore, () => {
			const frame = requestAnimationFrame(loadEarlier);
			onCleanup(() => cancelAnimationFrame(frame));
		}),
	);
	// An unpinned viewport keeps its on-screen content where it is while cards
	// above it hide or return: capture before the list's DOM changes (a computed
	// runs before render effects), restore once it has (a user effect runs after).
	// A pinned viewport needs nothing: the sticky-scroll observer re-snaps it.
	let anchors: ScrollAnchor[] = [];
	createComputed(
		on(
			index.hiddenRev,
			() => {
				anchors = jumpVisible() ? captureScrollAnchors(scroller, anchorRows()) : [];
			},
			{ defer: true },
		),
	);
	createEffect(
		on(
			index.hiddenRev,
			() => {
				restoreScrollAnchor(scroller, anchors);
				anchors = [];
			},
			{ defer: true },
		),
	);
	return (
		<div class={props.class ? `chat-transcript-wrap ${props.class}` : "chat-transcript-wrap"}>
			<div
				class="chat-transcript"
				ref={(el) => {
					scroller = el;
					containerRef(el);
				}}
			>
				{/* Observed by useStickyScroll's ResizeObserver: any growth here
				    (streamed text, tool output, mode switches, run toggles, image
				    decodes) re-pins a pinned viewport. The zoom overlay stays
				    outside since it's position:fixed and must not count as content. */}
				<div
					class="chat-transcript-content"
					ref={(el) => {
						content = el;
						contentRef(el);
					}}
				>
					<Show when={win.hiddenBefore() > 0}>
						<div class="chat-transcript-earlier">
							<button type="button" class="chat-transcript-earlier-btn" onClick={showEarlier}>
								Show earlier messages
							</button>
						</div>
					</Show>
					<For each={win.items()}>
						{(item) => (
							<Switch>
								<Match when={item.kind === "tool" && index.hidden(item.id)}>{null}</Match>
								<Match when={item.kind === "user" && item}>
									{(user) => (
										<UserCard
											user={user()}
											onZoom={openLightbox}
											branchable={session()}
											fold={!session() && props.items[0]?.id === user().id}
										/>
									)}
								</Match>
								<Match when={item.kind === "assistant" && item}>
									{(assistant) => (
										<AssistantCard
											assistant={assistant()}
											thinking={!index.consumed(assistant().id)}
											meta={index.turnMeta(assistant().id)}
										/>
									)}
								</Match>
								<Match when={item.kind === "tool" && index.toolSlot(item.id)}>
									{(slot) => (
										<Show when={toolRunOf(slot())}>
											{(run) => (
												<ToolRunRow
													run={run()}
													waitRuns={{ get: index.waitRunLed }}
													originOf={index.originOf}
												/>
											)}
										</Show>
									)}
								</Match>
								<Match
									when={item.kind === "tool" && item.name === "wait" && index.waitSlot(item.id)}
								>
									{(slot) => (
										<Show when={waitRunOf(slot())}>
											{(run) => <WaitToolCard calls={run().items} originOf={index.originOf} />}
										</Show>
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
									{(a) => <AdvisorCard item={a()} />}
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
