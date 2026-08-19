import { createMemo, createSignal, For, Match, Show, Switch, type Component } from "solid-js";
import { setState, state, type ToolItem } from "../../state";
import type { ImageArg } from "../../../shared/protocol";
import { FullImageOverlay } from "../shared/ImageScan";
import { ArrowDownIcon, ExpandIcon } from "../shared/icons";
import { ToolCard, ToolStripCard } from "./ToolCard";
import { groupToolRuns, type Run } from "../../chat/tool-runs";
import { useStickyScroll } from "./useStickyScroll";
import { LiveBlock } from "./StreamingText";
import {
	AssistantCard,
	BashCard,
	CompactionCard,
	NoticeCard,
	RunRow,
	UserCard,
	pruneRunOpen,
} from "./cards";

const TOOL_CARD_VIEWS = ["expanded", "collapsed", "consolidated"] as const;

export const MessageList: Component = () => {
	const [zoomed, setZoomed] = createSignal<ImageArg | null>(null);
	const { containerRef, jumpVisible, jumpToBottom, applyPinState } = useStickyScroll();
	// Memoized so the items scan runs on items/toolCardsView changes, not every render.
	const showToolbar = createMemo(
		() => state.toolCardsView !== "expanded" || state.items.some((it) => it.kind === "tool"),
	);
	// Consolidated view: every tool id → its run, plus the set of assistant ids
	// whose thinking was folded into a run. Read only in the tool/assistant
	// branches while consolidated, so expanded/collapsed rows never re-render on appends.
	const runOf = createMemo(() => {
		const m = new Map<number, Run>();
		const consumedIds = new Set<number>();
		const keys: number[] = [];
		for (const run of groupToolRuns(state.items)) {
			keys.push(run.key);
			for (const t of run.tools) m.set(t.id, run);
			for (const id of run.consumedAssistantIds) consumedIds.add(id);
		}
		// Drop expanded-run keys that no longer exist (session switches reset ids).
		pruneRunOpen(new Set(keys));
		return { m, consumedIds };
	});
	// The run an item leads (its first member), or null — the consolidated view
	// renders one row per run on the first member's slot.
	const leadRun = (item: ToolItem) => {
		const run = runOf().m.get(item.id);
		return run && run.key === item.id ? run : null;
	};
	return (
		<>
			<Show when={showToolbar()}>
				<div class="stream-toolbar">
					<For each={TOOL_CARD_VIEWS}>
						{(mode) => (
							<button
								class="stream-cards-toggle"
								aria-pressed={state.toolCardsView === mode}
								title={`Show tool cards: ${mode}`}
								onClick={() => setState("toolCardsView", mode)}
							>
								{mode}
							</button>
						)}
					</For>
					{/* Expand-all tool outputs (Ctrl+O); only meaningful in expanded/collapsed views. */}
					<button
						class="stream-cards-toggle"
						aria-pressed={state.toolsExpanded}
						title="Expand all tool outputs (Ctrl+O)"
						onClick={() => setState("toolsExpanded", (v) => !v)}
					>
						<ExpandIcon /> expand
					</button>
				</div>
			</Show>
			<div class="message-list-wrap">
				<div class="message-list" ref={containerRef} onScroll={applyPinState}>
					<For each={state.items}>
						{(item) => (
							<Switch>
								<Match when={item.kind === "user" && item}>
									{(user) => <UserCard user={user()} onZoom={setZoomed} />}
								</Match>
								<Match when={item.kind === "assistant" && item}>
									{(assistant) => (
										<Show
											when={state.toolCardsView === "consolidated"}
											fallback={<AssistantCard assistant={assistant()} thinking />}
										>
											{/* Consolidated: assistant messages are never folded into a run row — they
								    always render as cards. Thinking is hidden only when a following tool run
								    consumed it (it's shown inside the run row). */}
											<AssistantCard
												assistant={assistant()}
												thinking={!runOf().consumedIds.has(assistant().id)}
											/>
										</Show>
									)}
								</Match>
								<Match when={item.kind === "tool" && item}>
									{(tool) => (
										<Show
											when={state.toolCardsView === "consolidated"}
											fallback={
												<Show
													when={state.toolCardsView === "expanded"}
													fallback={<ToolStripCard item={tool()} />}
												>
													<ToolCard item={tool()} />
												</Show>
											}
										>
											{/* Consolidated: one row per run on its first member; later members render nothing. */}
											<Show when={leadRun(tool())} keyed fallback={null}>
												{(run) => <RunRow run={run} />}
											</Show>
										</Show>
									)}
								</Match>
								<Match when={item.kind === "bash" && item}>
									{(bash) => <BashCard item={bash()} />}
								</Match>
								<Match when={item.kind === "compaction" && item}>
									{(c) => <CompactionCard item={c()} />}
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
										<details class="thinking-block" open>
											<summary>thinking</summary>
											<LiveBlock block={block} />
										</details>
									) : (
										<LiveBlock block={block} />
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
						<div class="live-shimmer" aria-hidden="true">
							<span class="shimmer-text">{state.workingIntent ?? "Working…"}</span>
						</div>
					</Show>
					<Show when={zoomed()}>
						{(img) => <FullImageOverlay image={img()} onClose={() => setZoomed(null)} />}
					</Show>
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
						<ArrowDownIcon /> Jump to bottom
					</button>
				</Show>
			</div>
		</>
	);
};
