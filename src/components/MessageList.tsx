import { createEffect, For, Match, Show, Switch, type Component } from "solid-js";
import { renderMarkdown, splitForStreaming } from "../markdown";
import { call, state, type Block } from "../state";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";

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
	// Auto-scroll only when the user is already near the bottom.
	createEffect(() => {
		state.items.length;
		state.live.blocks.map(b => b.text.length);
		const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
		if (nearBottom) container.scrollTop = container.scrollHeight;
	});
	return (
		<div class="message-list" ref={container}>
			<For each={state.items}>
				{item => (
					<Switch>
						<Match when={item.kind === "user" && item}>
							{user => <div class="msg-user">{user().text}</div>}
						</Match>
						<Match when={item.kind === "assistant" && item}>
							{assistant => (
								<div class="msg-assistant">
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
								</div>
							)}
						</Match>
						<Match when={item.kind === "tool" && item}>{tool => <ToolCard item={tool()} />}</Match>
					<Match when={item.kind === "bash" && item}>
						{bash => (
							<div class="bash-card" classList={{ dimmed: bash().dimmed }}>
								<div class="bash-header">
									<span class="bash-cmd">$ {bash().command}</span>
									{bash().status === "running" ? (
										<>
											<span class="tool-status" data-status="running">
												running
											</span>
											<button class="bash-abort" onClick={() => void call("abortBash").catch(() => {})}>
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
		</div>
	);
};
