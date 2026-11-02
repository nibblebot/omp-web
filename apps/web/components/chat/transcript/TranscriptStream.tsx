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
import { ReplyWrite, ToolReplies } from "../tools/ToolReplies";
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
import { createTranscriptWindow, revealDownTo } from "../../../chat/transcript-window";
import { registerToolReveal } from "../../../chat/tool-jump";
import { isReplyWrite } from "../../../chat/tool-replies";
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

/** Work one backfill chunk aims at, so it is never a long task. */
const BACKFILL_SLICE_MS = 16;
/** Longest an idle callback waits before it runs anyway: a page that never goes idle still backfills. */
const BACKFILL_IDLE_TIMEOUT_MS = 40;
/** Items in the first backfill chunk, and the most one chunk takes. */
const BACKFILL_FIRST_CHUNK = 4;
const BACKFILL_MAX_CHUNK = 120;

/** Run `task` when the browser is idle (at the latest after a timeout); a timer where idle callbacks do not exist. */
const scheduleIdle = (task: (idle: { timeRemaining(): number }) => void): number =>
	typeof requestIdleCallback === "function"
		? requestIdleCallback(task, { timeout: BACKFILL_IDLE_TIMEOUT_MS })
		: window.setTimeout(() => task({ timeRemaining: () => 0 }), 16);
const cancelIdle = (handle: number): void => {
	if (typeof cancelIdleCallback === "function") cancelIdleCallback(handle);
	else clearTimeout(handle);
};

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
	const { containerRef, contentRef, jumpVisible, jumpToBottom, release } = useStickyScroll({
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
	// A long transcript opens at its tail and mounts the rest in time-sliced chunks
	// (see chat/transcript-window.ts).
	const win = createTranscriptWindow(() => props.items, { leadOf: index.leadOf });
	let scroller!: HTMLDivElement;
	let content!: HTMLDivElement;
	// Mount older items above the viewport without moving what the reader sees: a
	// pinned viewport re-snaps to the live edge, an unpinned one is anchored to the
	// card on screen. Returns whether anything was mounted.
	const mountEarlier = (count?: number): boolean => {
		// A pinned viewport needs nothing: the sticky-scroll observer re-snaps it after layout.
		if (!jumpVisible()) return win.showEarlier(count);
		const anchors = captureScrollAnchors(scroller, content.children);
		const mounted = win.showEarlier(count);
		restoreScrollAnchor(scroller, anchors);
		return mounted;
	};
	// Chunk size, steered to the slice: a mount has a cost per item plus one that grows with the
	// mounted list, so a measured per-item price would shrink the chunks as the list grows and
	// never recover. One controller serves the backfill, the near-top loader and jumps.
	let chunk = BACKFILL_FIRST_CHUNK;
	const mountSlice = (limit = Number.POSITIVE_INFINITY): boolean => {
		const count = Math.min(chunk, limit);
		const t0 = performance.now();
		const mounted = mountEarlier(count);
		if (count === chunk) {
			const took = Math.max(0.5, performance.now() - t0);
			const steer = Math.min(2, Math.max(0.5, BACKFILL_SLICE_MS / took));
			chunk = Math.max(1, Math.min(BACKFILL_MAX_CHUNK, Math.round(chunk * steer)));
		}
		return mounted;
	};
	// Older items mount before the reader runs out of mounted content: when the
	// top of the screen is within LOAD_AHEAD_SCREENS viewports of the oldest card.
	const loadEarlier = () => {
		if (win.hiddenBefore() === 0 || scroller.clientHeight === 0) return;
		if (scroller.scrollTop < scroller.clientHeight * LOAD_AHEAD_SCREENS) mountSlice();
	};
	// A pinned viewport scrolls on every snap; only the reader's own scrolling can near the top.
	const onScroll = () => {
		if (jumpVisible()) loadEarlier();
	};
	onMount(() => {
		// A reveal in flight when this stream unmounts has nothing left to mount into: the
		// window stops moving `hiddenBefore` once its owner is disposed.
		let disposed = false;
		onCleanup(() => {
			disposed = true;
		});
		scroller.addEventListener("scroll", onScroll, { passive: true });
		onCleanup(() => scroller.removeEventListener("scroll", onScroll));
		onCleanup(
			registerToolReveal(async (toolCallId) => {
				const target = win.revealStart(
					(item) => item.kind === "tool" && item.toolCallId === toolCallId,
				);
				if (target === undefined) return false;
				// The jump leaves the live edge: without the release, the content the mount adds re-snaps a pinned viewport to it.
				release();
				// Mount down to the card in slices, yielding between them so the page stays responsive;
				// another transcript opening meanwhile, or this stream unmounting, makes the card moot.
				return revealDownTo(win, target, { mountSlice, disposed: () => disposed });
			}),
		);
	});
	// Backfill: in idle time, mount older items in time-sliced chunks until the first item is
	// mounted. A new transcript (a session switch) cancels the old backfill.
	createEffect(
		on(win.epoch, () => {
			let cancelled = false;
			let handle: number | undefined;
			const next = () => {
				handle = scheduleIdle((idle) => {
					handle = undefined;
					// One chunk, and more while this idle period has room for them.
					do {
						if (cancelled || win.hiddenBefore() === 0) return;
						mountSlice();
					} while (idle.timeRemaining() > BACKFILL_SLICE_MS);
					next();
				});
			};
			next();
			onCleanup(() => {
				cancelled = true;
				if (handle !== undefined) cancelIdle(handle);
			});
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
				anchors = jumpVisible() ? captureScrollAnchors(scroller, content.children) : [];
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
								{/* A reply write is prose to the user: it draws even with tool activity hidden. */}
								<Match when={item.kind === "tool" && isReplyWrite(item) && item}>
									{(reply) => <ReplyWrite item={reply()} />}
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
								{/* With tool activity hidden no card draws, but a call's out:// replies still do. */}
								<Match when={item.kind === "tool" && hideToolActivity() && item}>
									{(tool) => <ToolReplies item={tool()} />}
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
