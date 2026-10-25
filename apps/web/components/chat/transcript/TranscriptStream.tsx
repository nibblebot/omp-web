import {
	createComputed,
	createEffect,
	createMemo,
	For,
	Match,
	on,
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
import { buildTurnMeta } from "../../../chat/turn-usage";
import { buildWaitRuns, type WaitRun } from "../../../chat/wait-runs";
import { transcriptItemsFor } from "../../../chat/activity-cards";
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
	UserCard,
	UserCommandCard,
} from "./cards";

/** The runs of a stream with tool activity hidden: none, so the hidden waits stay hidden. */
const NO_WAIT_RUNS: ReadonlyMap<number, WaitRun> = new Map();

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
	// Consecutive wait calls with nothing visible between them fold into one
	// card, drawn at the run's first call. Derived from the items alone (never
	// from a live-only field), so a history reload folds as the stream did.
	const waitRuns = createMemo<ReadonlyMap<number, WaitRun>>(() =>
		hideToolActivity()
			? NO_WAIT_RUNS
			: buildWaitRuns(props.items, {
					hideThinking: hideThinkingBlock(),
					proseOnlyThinking: proseOnlyThinking(),
					showTokenUsage: showTokenUsage(),
					turnMeta: turnMeta(),
				}),
	);
	// The main transcript drops the cards the open Activities panel shows
	// instead. Runs and turn metadata above stay computed on the full list.
	// A subagent's own stream (inside the panel's detail) keeps all its cards.
	const shownItems = createMemo(() =>
		transcriptItemsFor(props.items, session() && isActivitiesOpen()),
	);
	// An unpinned viewport keeps its on-screen content where it is while cards
	// above it hide or return: capture before the list's DOM changes (a computed
	// runs before render effects), restore once it has (a user effect runs after).
	// A pinned viewport needs nothing: the sticky-scroll observer re-snaps it.
	let scroller!: HTMLDivElement;
	let content!: HTMLDivElement;
	let anchors: ScrollAnchor[] = [];
	createComputed(
		on(
			shownItems,
			() => {
				anchors = jumpVisible() ? captureScrollAnchors(scroller, content.children) : [];
			},
			{ defer: true },
		),
	);
	createEffect(
		on(
			shownItems,
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
					<For each={shownItems()}>
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
								<Match
									when={item.kind === "tool" && item.name === "wait" && waitRuns().get(item.id)}
								>
									{(run) => (
										<Show when={run().items[0]?.id === item.id}>
											<WaitToolCard calls={run().items} transcript={props.items} />
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
