import { createEffect, createSignal, For, Match, Show, Switch, type Component } from "solid-js";
import { renderMarkdown, splitForStreaming } from "../markdown";
import { call, pushNotice, setState, state, type Block } from "../state";
import type { ImageArg } from "../../shared/protocol";
import { imageDataUrl } from "../images";
import { FullImageOverlay } from "./tools/ImageScan";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { ToolCard, ToolStripCard } from "./ToolCard";
import { buildUsageRow, formatUsageRow } from "../usage";

// Elements that cannot carry text children; append the fresh span to their parent instead.
const VOID_TAGS: Record<string, true> = { BR: true, HR: true, IMG: true, INPUT: true, WBR: true };

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
	const split = () => splitForStreaming(props.block.text, false);
	return (
		<>
			<For each={split().complete}>{segment => <Markdown src={segment} />}</For>
			<LiveTail text={split().tail} />
		</>
	);
};

export const MessageList: Component = () => {
	let container!: HTMLDivElement;
	const [zoomed, setZoomed] = createSignal<ImageArg | null>(null);
	// Auto-scroll only when the user is already near the bottom.
	createEffect(() => {
		state.items.length;
		state.live.blocks.map(b => b.text.length);
		const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
		if (nearBottom) container.scrollTop = container.scrollHeight;
	});
	return (
		<>
			<Show when={state.toolCardsCollapsed || state.items.some(it => it.kind === "tool")}>
				<div class="stream-toolbar">
					<button
						class="stream-cards-toggle"
						aria-pressed={state.toolCardsCollapsed}
						title={state.toolCardsCollapsed ? "Expand tool cards" : "Collapse tool cards"}
						onClick={() => setState("toolCardsCollapsed", v => !v)}
					>
						{state.toolCardsCollapsed ? "expand cards" : "collapse cards"}
					</button>
				</div>
			</Show>
			<div class="message-list" ref={container}>
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
															<img src={imageDataUrl(img)} alt="user attached image" />
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
								<div class="msg-assistant">
									<div class="msg-toolbar">
										<CopyButton
											class="msg-copy-btn"
											title="Copy message markdown"
											text={() => {
												const blocks = assistant().blocks;
												const visible = blocks.filter(b => b.kind !== "thinking");
												return (visible.length > 0 ? visible : blocks).map(b => b.text).join("\n\n");
											}}
										/>
									</div>
									<For each={assistant().blocks}>
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
										<Show when={assistant().usage}>
											{u => {
												const row = buildUsageRow(u(), assistant().ttft, assistant().duration);
												return row ? (
													<div class="usage-row" title="per-turn usage">
														{formatUsageRow(row)}
													</div>
												) : null;
											}}
										</Show>
									</div>
							)}
						</Match>
						<Match when={item.kind === "tool" && item}>
							{tool => (
								<Show
									when={!state.toolCardsCollapsed}
									fallback={<ToolStripCard item={tool()} />}
								>
									<ToolCard item={tool()} />
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
