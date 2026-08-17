import { createEffect, createMemo, For, type Component } from "solid-js";
import { renderMarkdown, splitForStreaming } from "../../markdown";
import { state, type Block } from "../../state";
import { Markdown } from "../shared/Markdown";

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
const LiveTail: Component<{ text: string }> = (props) => {
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

/** Live-streaming block: the memoized split renders settled text as frozen
 *  paragraphs and the tail as a softening stream (160ms re-parse on pause). */
export const LiveBlock: Component<{ block: Block }> = (props) => {
	// splitForStreaming is a full O(n) scan of the block text; memoize it so
	// each text change pays for the scan once instead of once per split() read.
	const split = createMemo(() => splitForStreaming(props.block.text, false));
	return (
		<>
			<For each={split().complete}>{(segment) => <Markdown src={segment} />}</For>
			<LiveTail text={split().tail} />
		</>
	);
};
