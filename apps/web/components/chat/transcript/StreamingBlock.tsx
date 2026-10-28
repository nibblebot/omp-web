import { createEffect, createMemo, For, onCleanup, untrack, type Component } from "solid-js";
import { formatThinkingForDisplay } from "../../../chat/thinking";
import { createStreamSplitter, renderMarkdown } from "../../../text/markdown";
import { state, type Block } from "../../../state";
import { Markdown } from "../../ui/Markdown";

// Elements that cannot carry text children; append the fresh span to their parent instead.
const VOID_TAGS: Record<string, true> = { BR: true, HR: true, IMG: true, INPUT: true, WBR: true };

// Appends the freshly-revealed text as one span at the end of the deepest last
// element, so it inherits the surrounding inline context (<p>, <code>, <strong>…).
// The span is recreated on every flush, which restarts its mount-triggered CSS
// animation. A transition would never fire on a newly-created element.
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

// A tail render slower than this (a multi-KB table or list still growing) makes
// the next one wait SLOW_TAIL_GAP times as long as the last took, which keeps
// the tail under about a fifth of the main thread however large it grows.
const SLOW_TAIL_MS = 4;
const SLOW_TAIL_GAP = 4;

// Renders the live tail like Markdown, but when Soft fade (state.display.softFade) is on, the characters
// appended since the previous frame are excluded from the markdown parse and
// shown in a single fading span instead (re-parsed into real markdown next frame).
const StreamingTail: Component<{ text: string }> = (props) => {
	let el!: HTMLDivElement;
	let prevLen = 0;
	let lastCost = 0;
	let lastEnd = 0;
	let deferred: ReturnType<typeof setTimeout> | undefined;
	const draw = (text: string, softFade: boolean) => {
		const started = performance.now();
		const freshCount = softFade ? text.length - prevLen : 0;
		prevLen = text.length;
		const cut = Math.min(Math.max(freshCount, 0), text.length);
		// Skip the fresh span when there is no stable text to anchor it to
		// (e.g. start of a new tail segment). An unwrapped span would miss
		// the paragraph styling for a frame.
		if (cut === 0 || cut === text.length) {
			el.innerHTML = renderMarkdown(text, { cache: false });
		} else {
			el.innerHTML = renderMarkdown(text.slice(0, text.length - cut), { cache: false });
			appendFresh(el, text.slice(text.length - cut));
			// The fresh span holds raw, unreparsed markdown source. Once its fade
			// has played, re-parse the full text so raw syntax never lingers when
			// the stream pauses. Skipped if a newer render happened meanwhile. The
			// re-parse is DOM-only, but the sticky-scroll content ResizeObserver
			// sees the size change and re-snaps a pinned viewport.
			setTimeout(() => {
				if (el.isConnected && prevLen === text.length) {
					el.innerHTML = renderMarkdown(text, { cache: false });
				}
			}, 160);
		}
		lastEnd = performance.now();
		lastCost = lastEnd - started;
	};
	createEffect(() => {
		const text = props.text;
		const softFade = state.display.softFade;
		// A deferred draw reads the newest text itself.
		if (deferred !== undefined) return;
		// A tail that restarted (a new block began) is small again: draw at once.
		const wait =
			lastCost > SLOW_TAIL_MS && text.length >= prevLen
				? lastEnd + lastCost * SLOW_TAIL_GAP - performance.now()
				: 0;
		if (wait > 0) {
			deferred = setTimeout(() => {
				deferred = undefined;
				draw(
					untrack(() => props.text),
					untrack(() => state.display.softFade),
				);
			}, wait);
			return;
		}
		draw(text, softFade);
	});
	onCleanup(() => clearTimeout(deferred));
	return <div class="md" ref={el} />;
};

/** Live-streaming block: settled blocks render once as frozen segments and the
 *  tail, the block still growing, as a softening stream (160ms re-parse on pause).
 *  `proseOnly` formats thinking text the way the TUI does (fenced code elided). */
export const StreamingBlock: Component<{ block: Pick<Block, "text">; proseOnly?: boolean }> = (
	props,
) => {
	// The splitter lexes only the unfrozen remainder and keeps the frozen list's
	// identity until a block freezes, so a frame that only grows the tail does no
	// work per frozen segment.
	const splitter = createStreamSplitter();
	const split = createMemo(() =>
		splitter(props.proseOnly ? formatThinkingForDisplay(props.block.text, true) : props.block.text),
	);
	const frozen = createMemo(() => split().frozen);
	const tail = createMemo(() => split().tail);
	return (
		<>
			<For each={frozen()}>{(segment) => <Markdown src={segment} class="md-frozen" />}</For>
			<StreamingTail text={tail()} />
		</>
	);
};
