import { createMemo, createSignal, For, Match, Show, Switch, type Component } from "solid-js";
import { setState, state, type ToolItem } from "../../state";
import type { ImageArg } from "../../../shared/protocol";
import { FullImageOverlay } from "../shared/ImageScan";
import { ArrowDownIcon, ExpandIcon } from "../shared/icons";
import { ToolCard, ToolStripCard } from "./ToolCard";
import { groupAssistantRuns, type Run } from "../../chat/tool-runs";
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
	// id → run, for the consolidated view; read only in the tool/assistant
	// branches while consolidated, so expanded/collapsed rows never re-render on appends.
	const runOf = createMemo(() => {
		const m = new Map<number, Run>();
		const keys: number[] = [];
		for (const run of groupAssistantRuns(state.items)) {
			keys.push(run.key);
			for (const item of run.items) m.set(item.id, run);
		}
		// Drop expanded-run keys that no longer exist (session switches reset ids).
		pruneRunOpen(new Set(keys));
		return m;
	});
	// The run an item leads (its first member), or null — the consolidated view
	// renders one row per run on the first member's slot.
	const leadRun = (item: ToolItem) => {
		const run = runOf().get(item.id);
		return run && run.key === item.id ? run : null;
	};
	// The transcript's final assistant message (usually the summary of changes
	// and verifications): in consolidated view it pops out of the last run's
	// row and renders as a full card after it, excluded from the expansion.
	const lastAssistantId = createMemo(() => {
		const assistants = state.items.filter((i) => i.kind === "assistant");
		return assistants.length > 0 ? assistants[assistants.length - 1].id : undefined;
	});
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
											{/* Consolidated: the run row owns the whole run; the text stays a message. The
									    transcript's final assistant message (usually the summary) pops out and
									    renders as a full card after the run row, excluded from its expansion. */}
											<Show
												when={runOf().get(assistant().id)}
												keyed
												fallback={<AssistantCard assistant={assistant()} thinking />}
											>
												{(run) => {
													// Final summary: pops out of the run (only when it ends the run — a
													// tool-calling message keeps its tools inside the row).
													const lastPopped =
														run.items[run.items.length - 1]?.id === lastAssistantId();
													if (assistant().id === lastAssistantId() && lastPopped) {
														return <AssistantCard assistant={assistant()} thinking />;
													}
													if (run.key !== assistant().id) return null; // members render inside the run row
													return run.tools.length > 0 ||
														run.thinking.length > 0 ||
														run.items.length > 1 ? (
														<RunRow
															run={lastPopped ? { ...run, items: run.items.slice(0, -1) } : run}
														/>
													) : (
														<AssistantCard assistant={assistant()} thinking />
													); // lone text-only turn stays a plain card
												}}
											</Show>
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
