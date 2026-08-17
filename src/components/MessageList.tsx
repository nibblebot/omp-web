import { createEffect, createSignal, For, Match, Show, Switch, createMemo, onCleanup, onMount, type Component } from "solid-js";
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
import { ArrowDownIcon, ExpandIcon } from "../icons";

// Elements that cannot carry text children; append the fresh span to their parent instead.
const VOID_TAGS: Record<string, true> = { BR: true, HR: true, IMG: true, INPUT: true, WBR: true };

const TOOL_CARD_VIEWS = ["expanded", "collapsed", "consolidated"] as const;

// Right-edge hit zone treated as an inner scroller's own scrollbar: wheel
// there (or Alt+wheel anywhere over it) scrolls the inner area, not the session.
const INNER_SCROLLBAR_PX = 14;

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
	// Sticky-bottom auto-scroll: the stream snaps to the bottom on new content
	// until the user scrolls up, which unpins it and floats a jump-to-bottom
	// button over the stream; scrolling back near the bottom (or clicking the
	// button) re-pins. Starts pinned so a fresh attach/history load lands at
	// the bottom instead of the top.
	//
	// Unpinning happens SYNCHRONOUSLY in the input handlers, never from scroll
	// events: those dispatch asynchronously, so during active streaming a snap
	// write can land before the user's scroll event is processed and the
	// position already reads "at bottom" again — the user could never escape.
	// Scroll events also fire for PROGRAMMATIC shifts (resize clamping,
	// content growth), which must never unpin. So: gestures unpin (wheel-up
	// aimed at the session, scrollbar drag, up-keys, upward touch drag);
	// scroll events only RE-pin near the bottom, and re-snap when a
	// programmatic shift moved a pinned viewport.
	const PIN_DISTANCE_PX = 80;
	let pinned = true;
	let pinCheckRaf = 0;
	const [jumpVisible, setJumpVisible] = createSignal(false);
	const nearBottom = () => container.scrollHeight - container.scrollTop - container.clientHeight < PIN_DISTANCE_PX;
	const unpin = () => {
		// No room above → the gesture can't move the viewport; stay pinned.
		if (container.scrollTop <= 0) return;
		pinned = false;
		setJumpVisible(true);
	};
	const applyPinState = () => {
		if (nearBottom()) {
			pinned = true;
			setJumpVisible(false);
		} else if (pinned) {
			container.scrollTop = container.scrollHeight; // programmatic shift: re-snap
		} else {
			// Unpinned away from the bottom must ALWAYS show the re-pin
			// affordance — some paths (scrollbar drag starting at the bottom)
			// unpin without going through unpin().
			setJumpVisible(true);
		}
	};
	const schedulePinCheck = () => {
		if (pinCheckRaf !== 0) return;
		pinCheckRaf = requestAnimationFrame(() => {
			pinCheckRaf = 0;
			applyPinState();
		});
	};
	const jumpToBottom = () => {
		pinned = true;
		setJumpVisible(false);
		container.scrollTop = container.scrollHeight;
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
	// Session switches re-pin: a fresh transcript starts at the bottom no
	// matter where the previous session was scrolled (currentSessionId changes
	// on every attach/switch; the effect above then owns the snap as history
	// frames land).
	let lastSessionId = state.currentSessionId;
	createEffect(() => {
		const id = state.currentSessionId;
		if (id === lastSessionId) return;
		lastSessionId = id;
		pinned = true;
		setJumpVisible(false);
	});
	// Window resizes change clientHeight without a scroll event; a pinned
	// stream must re-snap or the bottom drifts out of view.
	onMount(() => {
		const ro = new ResizeObserver(() => {
			if (pinned) container.scrollTop = container.scrollHeight;
		});
		ro.observe(container);
		onCleanup(() => ro.disconnect());
	});
	// Session-first wheel scrolling. Tool bodies with their own vertical
	// scrollbar (search results; any future capped output) otherwise trap the
	// wheel: hovering them scrolls the inner area, and the session only moves
	// once the inner scroller hits its boundary. Redirect instead — wheel over
	// an inner scroller scrolls the session, unless the user explicitly asks
	// for inner scroll: Alt+wheel, or wheel over the scroller's own scrollbar.
	// At the scroller's boundary the event falls through to native scroll
	// chaining, which moves the session anyway.
	const onWheelRedirect = (e: WheelEvent) => {
		// Alt+wheel is the explicit "scroll this inner area" gesture; the other
		// modifiers are unrelated gestures (Ctrl zoom, Shift horizontal).
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (e.deltaY === 0) return; // horizontal-only wheel passes through
		// Wheel-up that will move the SESSION unpins synchronously (see the pin
		// comment above); wheel-down re-pins via the scroll event at the bottom.
		const unpinOnUp = () => {
			if (e.deltaY < 0) unpin();
		};
		let el = e.target as HTMLElement | null;
		let scroller: HTMLElement | null = null;
		while (el && el !== container) {
			const overflowY = getComputedStyle(el).overflowY;
			if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 1) {
				scroller = el;
				break;
			}
			el = el.parentElement;
		}
		if (!scroller) {
			unpinOnUp();
			return; // nothing captures the wheel → native session scroll
		}
		const atBoundary =
			e.deltaY > 0
				? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
				: scroller.scrollTop <= 0;
		if (atBoundary) {
			unpinOnUp();
			return; // native chaining moves the session
		}
		const rect = scroller.getBoundingClientRect();
		if (e.clientX >= rect.right - INNER_SCROLLBAR_PX) return; // over its scrollbar
		e.preventDefault();
		unpinOnUp();
		const delta =
			e.deltaMode === WheelEvent.DOM_DELTA_LINE
				? e.deltaY * 16
				: e.deltaMode === WheelEvent.DOM_DELTA_PAGE
					? e.deltaY * container.clientHeight
					: e.deltaY;
		container.scrollTop = Math.min(
			Math.max(0, container.scrollTop + delta),
			container.scrollHeight - container.clientHeight,
		);
	};
	// Scrollbar drags, scroll keys, and touch drags are the other unpin
	// gestures (wheel is handled in onWheelRedirect). All unpin SYNCHRONOUSLY
	// — waiting for the scroll event races the streaming snap writes.
	let scrollbarGrab = false;
	const onScrollbarMouseDown = (e: MouseEvent) => {
		// The stable gutter keeps the scrollbar strip at the container's right
		// edge; presses there are scrollbar grabs, not content interaction.
		if (e.clientX >= container.getBoundingClientRect().right - INNER_SCROLLBAR_PX) {
			scrollbarGrab = true;
			pinned = false;
			if (!nearBottom()) setJumpVisible(true);
		}
	};
	// Settle on release: a grab that never dragged (or ended at the bottom)
	// re-pins; a drag released mid-stream stays unpinned with the button up.
	const onMouseUp = () => {
		if (!scrollbarGrab) return;
		scrollbarGrab = false;
		applyPinState();
	};
	const onScrollKeyDown = (e: KeyboardEvent) => {
		// Bubbles from focused descendants (buttons, links, details). Scroll
		// keys are handled MANUALLY: native keyboard paging smooth-scrolls, and
		// during the animation the position lingers near the bottom, so the
		// deferred pin check would re-pin and the re-snap would kill the
		// animation — the same async race the synchronous unpin exists to avoid.
		const onInteractive = (e.target as HTMLElement).closest("button, a, input, textarea, select, summary");
		const page = container.clientHeight;
		switch (e.key) {
			case "PageUp":
				e.preventDefault();
				unpin();
				container.scrollTop = Math.max(0, container.scrollTop - page);
				break;
			case "PageDown":
				e.preventDefault();
				container.scrollTop += page; // scroll event re-pins near the bottom
				break;
			case "ArrowUp":
				e.preventDefault();
				unpin();
				container.scrollTop = Math.max(0, container.scrollTop - 40);
				break;
			case "ArrowDown":
				e.preventDefault();
				container.scrollTop += 40;
				break;
			case "Home":
				if (onInteractive) return;
				e.preventDefault();
				unpin();
				container.scrollTop = 0;
				break;
			case "End":
				if (onInteractive) return;
				e.preventDefault();
				container.scrollTop = container.scrollHeight;
				break;
			case " ":
				// Space ACTIVATES focused buttons/links — only Shift+Space (page
				// up) off interactive elements is ours.
				if (onInteractive || !e.shiftKey) return;
				e.preventDefault();
				unpin();
				container.scrollTop = Math.max(0, container.scrollTop - page);
				break;
		}
	};
	let lastTouchTop = 0;
	const onTouchStart = () => {
		lastTouchTop = container.scrollTop;
	};
	const onTouchMove = () => {
		if (container.scrollTop < lastTouchTop) unpin(); // finger dragged down: content moves up
		lastTouchTop = container.scrollTop;
	};
	onMount(() => {
		container.addEventListener("wheel", onWheelRedirect, { passive: false });
		container.addEventListener("mousedown", onScrollbarMouseDown);
		container.addEventListener("keydown", onScrollKeyDown);
		container.addEventListener("touchstart", onTouchStart, { passive: true });
		container.addEventListener("touchmove", onTouchMove, { passive: true });
		document.addEventListener("mouseup", onMouseUp);
	});
	onCleanup(() => {
		container.removeEventListener("wheel", onWheelRedirect);
		container.removeEventListener("mousedown", onScrollbarMouseDown);
		container.removeEventListener("keydown", onScrollKeyDown);
		container.removeEventListener("touchstart", onTouchStart);
		container.removeEventListener("touchmove", onTouchMove);
		document.removeEventListener("mouseup", onMouseUp);
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
					{/* Expand-all tool outputs (Ctrl+O); only meaningful in expanded/collapsed views. */}
					<button
						class="stream-cards-toggle"
						aria-pressed={state.toolsExpanded}
						title="Expand all tool outputs (Ctrl+O)"
						onClick={() => setState("toolsExpanded", v => !v)}
					>
						<ExpandIcon /> expand
					</button>
				</div>
			</Show>
			<div class="message-list-wrap">
			<div class="message-list" ref={container} onScroll={applyPinState}>
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
			{/* In-progress shimmer: spans the whole agent turn (tool gaps included),
			    not just the live message card. Label tracks the latest tool-call
			    intent like the TUI working message; the TUI's default phrase
			    ("Working…") applies until the first intent lands. */}
			<Show when={state.streaming}>
				<div class="live-shimmer" aria-hidden="true">
					<span class="shimmer-text">{state.workingIntent ?? "Working…"}</span>
				</div>
			</Show>
			<Show when={zoomed()}>{img => <FullImageOverlay image={img()} onClose={() => setZoomed(null)} />}</Show>
			</div>
			{/* Floated over the stream's lower-right while unpinned; one click
			    re-pins and lands at the live edge. */}
			<Show when={jumpVisible()}>
				<button class="jump-to-bottom" onClick={jumpToBottom} title="Jump to bottom" aria-label="Jump to bottom">
					<ArrowDownIcon /> Jump to bottom
				</button>
			</Show>
			</div>
		</>
	);
};
