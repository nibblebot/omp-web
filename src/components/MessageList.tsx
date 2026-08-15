import { createEffect, createSignal, For, Match, Show, Switch, createMemo, onCleanup, type Component } from "solid-js";
import { renderMarkdown, splitForStreaming } from "../markdown";
import { call, pushNotice, setState, state, type Block, type ChatItem, type ToolItem } from "../state";
import type { ImageArg } from "../../shared/protocol";
import { imageDataUrl } from "../images";
import { FullImageOverlay } from "./tools/ImageScan";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { ToolCard, ToolStripCard } from "./ToolCard";
import { groupAssistantRuns, type Run } from "../tool-runs";
import { buildUsageRow, formatDurationMs, formatUsageRow } from "../usage";

// Elements that cannot carry text children; append the fresh span to their parent instead.
const VOID_TAGS: Record<string, true> = { BR: true, HR: true, IMG: true, INPUT: true, WBR: true };

const TOOL_CARD_VIEWS = ["expanded", "collapsed", "consolidated"] as const;

// Expanded run keys, module-level so they survive row re-renders while a run
// grows (same pattern as DaemonSidebar's activatingIds).
const expandedRunKeys = new Set<number>();
const [runOpenVersion, setRunOpenVersion] = createSignal(0);

/** Drop expanded-run keys that no longer exist (session switches reset item ids). */
export function pruneRunOpen(validKeys: ReadonlySet<number>): void {
	for (const k of expandedRunKeys) if (!validKeys.has(k)) expandedRunKeys.delete(k);
}

// Appends the freshly-revealed text as one span at the end of the deepest last
// element, so it inherits the surrounding inline context (<p>, <code>, <strong>…).
// The span is recreated on every flush, which restarts its mount-triggered CSS
// animation — a transition would never fire on a newly-created element.
function appendFresh(root: HTMLElement, text: string): void {
	let node: HTMLElement = root;
	for (;;) {
		const last = node.lastElementChild;
		if (!last || VOID_TAGS[last.tagName]) break;
		node = last as HTMLElement;
	}
	const span = document.createElement("span");
	span.className = "fresh";
	span.textContent = text;
	node.appendChild(span);
}

// Renders the live tail like Markdown, but when `soften` is on, the characters
// appended since the previous frame are excluded from the markdown parse and
// shown in a single fading span instead (re-parsed into real markdown next frame).
const LiveTail: Component<{ text: string }> = props => {
	let el!: HTMLDivElement;
	let prevLen = 0;
	createEffect(() => {
		const text = props.text;
		const freshCount = state.soften ? text.length - prevLen : 0;
		prevLen = text.length;
		const cut = Math.min(Math.max(freshCount, 0), text.length);
		// Skip the fresh span when there is no stable text to anchor it to
		// (e.g. start of a new tail segment) — an unwrapped span would miss
		// the paragraph styling for a frame.
		if (cut === 0 || cut === text.length) {
			el.innerHTML = renderMarkdown(text);
			return;
		}
		el.innerHTML = renderMarkdown(text.slice(0, text.length - cut));
		appendFresh(el, text.slice(text.length - cut));
		// The fresh span holds raw, unreparsed markdown source. Once its fade
		// has played, re-parse the full text so raw syntax never lingers when
		// the stream pauses. Skipped if a newer render happened meanwhile.
		setTimeout(() => {
			if (el.isConnected && prevLen === text.length) el.innerHTML = renderMarkdown(text);
		}, 160);
	});
	return <div class="md" ref={el} />;
};

const LiveBlock: Component<{ block: Block }> = props => {
	// splitForStreaming is a full O(n) scan of the block text; memoize it so
	// each text change pays for the scan once instead of once per split() read.
	const split = createMemo(() => splitForStreaming(props.block.text, false));
	return (
		<>
			<For each={split().complete}>{segment => <Markdown src={segment} />}</For>
			<LiveTail text={split().tail} />
		</>
	);
};

/** Assistant message card. With `thinking` false, thinking blocks are omitted
 *  (consumed by a consolidated run row); a card with no text blocks then
 *  renders nothing. */
const AssistantCard: Component<{ assistant: Extract<ChatItem, { kind: "assistant" }>; thinking: boolean }> = props => {
	const blocks = () => (props.thinking ? props.assistant.blocks : props.assistant.blocks.filter(b => b.kind !== "thinking"));
	const text = () => blocks().filter(b => b.kind === "text");
	if (!props.thinking && text().length === 0) return null;
	return (
		<div class="msg-assistant">
			<div class="msg-toolbar">
				<CopyButton
					class="msg-copy-btn"
					title="Copy message markdown"
					text={() => {
						const visible = blocks().filter(b => b.kind !== "thinking");
						return (visible.length > 0 ? visible : props.assistant.blocks).map(b => b.text).join("\n\n");
					}}
				/>
			</div>
			<For each={blocks()}>
				{block =>
					block.kind === "thinking" ? (
						<details class="thinking-block">
							<summary>thinking</summary>
							<Markdown src={block.text} />
						</details>
					) : (
						<Markdown src={block.text} />
					)
				}
			</For>
			<Show when={props.assistant.usage}>
				{u => {
					const row = buildUsageRow(u(), props.assistant.ttft, props.assistant.duration);
					return row ? (
						<div class="usage-row" title="per-turn usage">
							{formatUsageRow(row)}
						</div>
					) : null;
				}}
			</Show>
		</div>
	);
};

/** Consolidated view: one row per run of consecutive assistant messages and
 *  tool calls, e.g. "4 Read • 2 Glob • 1 thinking • 7 req • 3 turns". */
export const RunRow: Component<{ run: Run }> = props => {
	const open = () => {
		void runOpenVersion();
		return expandedRunKeys.has(props.run.key);
	};
	const toggle = () => {
		if (expandedRunKeys.has(props.run.key)) expandedRunKeys.delete(props.run.key);
		else expandedRunKeys.add(props.run.key);
		setRunOpenVersion(v => v + 1);
	};
	// Per-name tool counts in first-seen order, plus a "thinking" segment when present.
	const segments = () => {
		const map = new Map<string, number>();
		const order: string[] = [];
		for (const item of props.run.tools) {
			if (!map.has(item.name)) order.push(item.name);
			map.set(item.name, (map.get(item.name) ?? 0) + 1);
		}
		const tools = order.map(name => ({ name, count: map.get(name)! }));
		return props.run.thinking.length > 0
			? [...tools, { name: "thinking", count: props.run.thinking.length }]
			: tools;
	};
	// Meta segments in fixed order: err, req, duration, turns. Rendered as one
	// For (fragments are only legal inside a JSX callback, not under <button>).
	const meta = () => {
		const m: Array<{ tone?: "err"; text: string }> = [];
		if (props.run.errorCount > 0) m.push({ tone: "err", text: `${props.run.errorCount} err` });
		if (props.run.requestCount > 0) m.push({ text: `${props.run.requestCount} req` });
		if (props.run.durationMs > 0) m.push({ text: formatDurationMs(props.run.durationMs) });
		m.push({ text: `${props.run.turnCount} turns` });
		return m;
	};
	const names = () =>
		[...props.run.tools.map(it => it.name), ...props.run.thinking.map(() => "thinking")].join(" · ");
	return (
		<div class="run-row" classList={{ open: open() }} data-running={props.run.running}>
			<button
				type="button"
				class="run-row-summary"
				aria-expanded={open()}
				title={names()}
				onClick={toggle}
			>
				<Show when={props.run.running}>
					<span class="run-row-dot" aria-hidden="true" />
				</Show>
				<For each={segments()}>
					{(seg, i) => (
						<>
							{i() > 0 && <span class="run-row-sep" aria-hidden="true">•</span>}
							<span class="run-row-item">
								<span class="run-row-count">{seg.count}</span>
								<span class="run-row-name">{seg.name}</span>
							</span>
						</>
					)}
				</For>
				<For each={meta()}>
					{m => (
						<>
							<span class="run-row-sep" aria-hidden="true">•</span>
							<span class="run-row-meta" data-tone={m.tone}>{m.text}</span>
						</>
					)}
				</For>
			</button>
			<Show when={open()}>
				<div class="run-row-content">
					{/* Original stream order: assistant messages (with thinking) and tools interleaved. */}
					<For each={props.run.items}>
						{item =>
							item.kind === "tool" ? (
								<ToolStripCard item={item} />
							) : (
								<AssistantCard assistant={item} thinking />
							)
						}
					</For>
				</div>
			</Show>
		</div>
	);
};

export const MessageList: Component = () => {
	let container!: HTMLDivElement;
	const [zoomed, setZoomed] = createSignal<ImageArg | null>(null);
	// Auto-scroll only when the user is already near the bottom. The near-bottom
	// check reads layout, so it never runs inside the streaming effect: the
	// effect only writes, and the read is deferred to one requestAnimationFrame
	// per frame (coalesced) plus the user's own scroll events — no forced
	// synchronous layout on every flush.
	let pinned = false;
	let pinCheckRaf = 0;
	const schedulePinCheck = () => {
		if (pinCheckRaf !== 0) return;
		pinCheckRaf = requestAnimationFrame(() => {
			pinCheckRaf = 0;
			pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
		});
	};
	const onContainerScroll = () => {
		pinned = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
	};
	onCleanup(() => {
		if (pinCheckRaf !== 0) cancelAnimationFrame(pinCheckRaf);
	});
	createEffect(() => {
		state.items.length;
		state.live.blocks.map(b => b.text.length);
		if (pinned) container.scrollTop = container.scrollHeight;
		schedulePinCheck();
	});
	// id → run, for the consolidated view. Read only from the tool/assistant
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
	// The run an item leads (its first member), or null — consolidated view
	// renders one row per run on the first member's slot.
	const leadRun = (item: ToolItem) => {
		const run = runOf().get(item.id);
		return run && run.key === item.id ? run : null;
	};
	// The transcript's final assistant message (usually the summary of changes
	// and verifications): in consolidated view it pops out of the last run's
	// row and renders as a full card after it, excluded from the expansion.
	const lastAssistantId = createMemo(() => {
		const assistants = state.items.filter(i => i.kind === "assistant");
		return assistants.length > 0 ? assistants[assistants.length - 1].id : undefined;
	});
	return (
		<>
			<Show when={state.toolCardsView !== "expanded" || state.items.some(it => it.kind === "tool")}>
				<div class="stream-toolbar">
					<For each={TOOL_CARD_VIEWS}>
						{mode => (
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
				</div>
			</Show>
			<div class="message-list" ref={container} onScroll={onContainerScroll}>
			<For each={state.items}>
				{item => (
					<Switch>
						<Match when={item.kind === "user" && item}>
							{user => {
								const images = () => user().images ?? [];
								// Phase 11: branch-from-here. AgentMessage user
								// payloads carry no entryId (pi-ai UserMessage has
								// no id field), so resolve it via the branching
								// list and match by exact text.
								const branchFromHere = (text: string) => {
									void call("getBranchMessages")
										.then(msgs => {
											const entry = (msgs as Array<{ entryId: string; text: string }>).find(m => m.text === text);
											if (!entry) {
												pushNotice("warning", "No branch point found for this message.");
												return undefined;
											}
											return call("branch", [entry.entryId]);
										})
										.then(result => {
											const r = result as { text?: string; cancelled?: boolean } | null;
											if (!r || r.cancelled) return;
											pushNotice("info", `branched at: ${(r.text ?? text).slice(0, 200)}`);
										})
										.catch(err => setState("error", String(err)));
								};
								return (
									<div class="msg-user">
										<div class="msg-toolbar">
											<button
												class="msg-branch-btn"
												title="Branch from here"
												disabled={!user().text}
												onClick={() => branchFromHere(user().text)}
											>
												branch
											</button>
											<CopyButton
												class="msg-copy-btn"
												title="Copy message text"
												text={() => user().text}
											/>
										</div>
										{user().text && <div class="msg-user-text">{user().text}</div>}
										<Show when={images().length > 0}>
											<div class="msg-user-images">
												<For each={images()}>
													{img => (
														<button class="img-thumb" type="button" onClick={() => setZoomed(img)}>
															<img src={imageDataUrl(img)} alt={`user attached image (${img.mimeType})`} decoding="async" />
														</button>
													)}
												</For>
											</div>
										</Show>
									</div>
								);
							}}
						</Match>
						<Match when={item.kind === "assistant" && item}>
							{assistant => (
								<Show
									when={state.toolCardsView === "consolidated"}
									fallback={<AssistantCard assistant={assistant()} thinking />}
								>
									{/* Consolidated: the run row owns the whole run; the text stays a message. The
									    transcript's final assistant message (usually the summary) pops out and
									    renders as a full card after the run row, excluded from its expansion. */}
									<Show when={runOf().get(assistant().id)} keyed fallback={<AssistantCard assistant={assistant()} thinking />}>
										{run => {
											// Final summary: pops out of the run (only when it ends the run — a
											// tool-calling message keeps its tools inside the row).
											const lastPopped = run.items[run.items.length - 1]?.id === lastAssistantId();
											if (assistant().id === lastAssistantId() && lastPopped) {
												return <AssistantCard assistant={assistant()} thinking />;
											}
											if (run.key !== assistant().id) return null; // members render inside the run row
											return run.tools.length > 0 || run.thinking.length > 0 || run.items.length > 1
												? <RunRow run={lastPopped ? { ...run, items: run.items.slice(0, -1) } : run} />
												: <AssistantCard assistant={assistant()} thinking />; // lone text-only turn stays a plain card
										}}
									</Show>
								</Show>
							)}
						</Match>
						<Match when={item.kind === "tool" && item}>
							{tool => (
								<Show
									when={state.toolCardsView === "consolidated"}
									fallback={
										<Show when={state.toolCardsView === "expanded"} fallback={<ToolStripCard item={tool()} />}>
											<ToolCard item={tool()} />
										</Show>
									}
								>
									{/* Consolidated: one row per run on its first member; later members render nothing. */}
									<Show when={leadRun(tool())} keyed fallback={null}>
										{run => <RunRow run={run} />}
									</Show>
								</Show>
							)}
						</Match>
						<Match when={item.kind === "bash" && item}>
						{bash => (
							<div class="bash-card" classList={{ dimmed: bash().dimmed }}>
								<div class="bash-header">
									<span class="bash-cmd">{bash().lang === "python" ? ">>> " : "$ "}{bash().command}</span>
									{bash().status === "running" ? (
										<>
											<span class="tool-status" data-status="running">
												running
											</span>
											<button
												class="bash-abort"
												onClick={() => void call(bash().lang === "python" ? "abortEval" : "abortBash").catch(() => {})}
											>
												abort
											</button>
										</>
									) : (
										<span class="exit-badge" classList={{ nonzero: bash().exitCode !== 0 }}>
											{bash().exitCode ?? "err"}
										</span>
									)}
								</div>
								{bash().output && <pre>{bash().output}</pre>}
								{bash().truncated && <div class="bash-truncated">(truncated)</div>}
							</div>
						)}
					</Match>
						<Match when={item.kind === "compaction" && item}>
						{c => (
							<details class="compaction-item">
								<summary>
									compaction ({c().action})
									{c().tokensBefore !== undefined && <span class="picker-detail"> · {c().tokensBefore} tokens before</span>}
									{c().skipped && <span class="picker-detail"> · skipped</span>}
									{c().aborted && <span class="picker-detail"> · aborted</span>}
								</summary>
								{c().errorMessage && <div class="msg-notice">{c().errorMessage}</div>}
								{c().summary && <Markdown src={c().summary!} />}
								{!c().summary && !c().errorMessage && <div class="tool-collapsed-note">no summary</div>}
							</details>
						)}
					</Match>
					<Match when={item.kind === "notice" && item}>
						{notice => (
							<div class="msg-notice">
								{notice().href ? (
									<a href={notice().href} target="_blank" rel="noreferrer">
										{notice().message}
									</a>
								) : (
									notice().message
								)}
							</div>
						)}
					</Match>
					</Switch>
				)}
			</For>
			<Show when={state.live.active}>
				<div class="msg-assistant live">
					<For each={state.live.blocks}>
						{block =>
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
			<Show when={zoomed()}>{img => <FullImageOverlay image={img()} onClose={() => setZoomed(null)} />}</Show>
			</div>
		</>
	);
};
