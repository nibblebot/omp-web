import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { setState, state } from "../../state";

// Right-edge hit zone treated as an inner scroller's own scrollbar: wheel
// there (or Alt+wheel anywhere over it) scrolls the inner area, not the session.
const INNER_SCROLLBAR_PX = 14;

// Re-pin band: within this many px of the live edge, a DOWNWARD gesture
// re-engages stickiness. Generous so trackpads/scrollbars don't need an exact
// bottom hit; small enough that a mid-stream scroll-up escapes cleanly.
const RE_PIN_DISTANCE_PX = 80;

/**
 * Imperative pin/unpin/gesture machinery for the message stream. Hands back
 * the container + content refs, the jump-to-bottom visibility signal, and the
 * jump button's click.
 *
 * Pin state is owned ENTIRELY by synchronous gesture handlers — scroll events
 * never touch it. Up-gestures (wheel-up, scrollbar grab, upward touch drag,
 * up-keys) unpin; down-gestures that land inside the re-pin band, plus the
 * jump button and session switches, re-pin. This closes the two failure
 * classes of distance-threshold scroll-event reconciliation:
 *
 * 1. A scroll event can't re-pin — they can't distinguish a user scrolling
 *    down from a browser clamp (LiveTail's soften re-parse or a shrink
 *    shifting scrollTop), so a small scroll-up during streaming can never be
 *    yanked back by the next event. Escape is irrevocable until the user
 *    gestures down into the band.
 * 2. Content growth can't move an unpinned viewport — snaps run only while
 *    pinned, so a pinned stream follows the live edge and an escaped one
 *    stays exactly where the user left it.
 *
 * While pinned, a ResizeObserver pair re-snaps the viewport to the live edge.
 * Observing the CONTENT element catches every growth source with one
 * mechanism: reveal-paced live text (each rAF flush grows the tail),
 * streamed tool/bash output (in-place item mutations that never change
 * items.length), toolCardsView mode switches (expanded/collapsed/
 * consolidated), Ctrl+O expand-all, consolidated run-row toggles, image
 * decodes, font reflows, LiveTail's 160ms soften re-parse. Observing the
 * CONTAINER catches viewport resizes (window/sidebar) that change
 * clientHeight without touching content. RO callbacks run after layout,
 * before paint, so a synchronous snap lands in the same frame as the change
 * (a store-signal effect would fire BEFORE child effects like LiveTail's
 * innerHTML write and read a stale scrollHeight); scrollTop writes can't feed
 * back because neither observed box changes size. Starts pinned so a fresh
 * attach/history load lands at the bottom.
 */
export function useStickyScroll(): {
	containerRef: (el: HTMLDivElement) => void;
	contentRef: (el: HTMLDivElement) => void;
	jumpVisible: () => boolean;
	jumpToBottom: () => void;
} {
	let container!: HTMLDivElement;
	let content!: HTMLDivElement;
	let pinned = true;
	let rePinRaf = 0;
	const [jumpVisible, setJumpVisible] = createSignal(false);
	// Mirror pin state into the store: agent_end (src/store/chat.ts) reads
	// chatPinned to decide whether the finished answer was viewed (unviewed →
	// the roster's yellow unreviewed dot), and every re-pin clears the flag.
	// The local var stays for the synchronous reads inside the handlers.
	const setPinned = (p: boolean) => {
		pinned = p;
		setState("chatPinned", p);
		if (p) setState("answerUnviewed", false);
	};
	const nearBottom = () =>
		container.scrollHeight - container.scrollTop - container.clientHeight < RE_PIN_DISTANCE_PX;
	const unpin = () => {
		// No room above → the gesture can't move the viewport; stay pinned.
		if (container.scrollTop <= 0) return;
		// A pending wheel-down re-pin check must not fire after the escape —
		// the viewport is still inside the band until the wheel-up lands, so
		// it would re-pin and snap back (the "can't unstick" race at rAF
		// granularity).
		if (rePinRaf !== 0) {
			cancelAnimationFrame(rePinRaf);
			rePinRaf = 0;
		}
		setPinned(false);
		setJumpVisible(true);
	};
	// Re-pin when a DOWNWARD gesture lands inside the band. Never called from
	// scroll events (see the module comment). No-op while already pinned:
	// gestures that would re-pin a pinned viewport (scrollbar release at the
	// bottom, PageDown, touch) must not redundantly clear answerUnviewed.
	const rePinIfNear = () => {
		if (!pinned && nearBottom()) {
			setPinned(true);
			setJumpVisible(false);
		}
	};
	const snapToBottom = () => {
		container.scrollTop = container.scrollHeight;
	};
	// Wheel-down is a continuous gesture: re-check the band on the frame
	// AFTER the browser applies each tick, so a single tick that jumps from
	// just-outside to inside the band still re-pins.
	const scheduleRePinCheck = () => {
		if (rePinRaf !== 0) return;
		rePinRaf = requestAnimationFrame(() => {
			rePinRaf = 0;
			rePinIfNear();
		});
	};
	const jumpToBottom = () => {
		setPinned(true);
		setJumpVisible(false);
		snapToBottom();
	};
	onCleanup(() => {
		if (rePinRaf !== 0) cancelAnimationFrame(rePinRaf);
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
		setPinned(true);
		setJumpVisible(false);
	});
	// Session-first wheel scrolling. Tool bodies with their own vertical
	// scrollbar (search results; any future capped output) otherwise trap the
	// wheel: hovering them scrolls the inner area, and the session only moves
	// once the inner scroller hits its boundary. Redirect instead — wheel over
	// an inner scroller scrolls the session, unless the user explicitly asks
	// for inner scroll: Alt+wheel, or wheel over the scroller's own scrollbar.
	// At the scroller's boundary the event falls through to native scroll
	// chaining, which moves the session anyway. Wheel-up unpins synchronously
	// in every path; wheel-down schedules the band re-pin check.
	const onWheelRedirect = (e: WheelEvent) => {
		// Alt+wheel is the explicit "scroll this inner area" gesture; the other
		// modifiers are unrelated gestures (Ctrl zoom, Shift horizontal).
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (e.deltaY === 0) return; // horizontal-only wheel passes through
		// Wheel-up that will move the SESSION unpins synchronously (see the
		// pin comment above); wheel-down re-pins once it lands in the band.
		const unpinOnUp = () => {
			if (e.deltaY < 0) unpin();
		};
		if (e.deltaY > 0) scheduleRePinCheck();
		let el = e.target as HTMLElement | null;
		let scroller: HTMLElement | null = null;
		while (el && el !== container) {
			const overflowY = getComputedStyle(el).overflowY;
			if (
				(overflowY === "auto" || overflowY === "scroll") &&
				el.scrollHeight > el.clientHeight + 1
			) {
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
	// Scrollbar drags, scroll keys, and touch drags are the other pin
	// gestures (wheel is handled in onWheelRedirect). All unpin/re-pin
	// SYNCHRONOUSLY — waiting for a scroll event races the streaming snaps.
	let scrollbarGrab = false;
	const onScrollbarMouseDown = (e: MouseEvent) => {
		// The stable gutter keeps the scrollbar strip at the container's right
		// edge; presses there are scrollbar grabs, not content interaction.
		if (e.clientX >= container.getBoundingClientRect().right - INNER_SCROLLBAR_PX) {
			scrollbarGrab = true;
			setPinned(false);
			if (!nearBottom()) setJumpVisible(true);
		}
	};
	// Settle on release: a grab that never dragged (or ended at the bottom)
	// re-pins; a drag released mid-stream stays unpinned with the button up.
	const onMouseUp = () => {
		if (!scrollbarGrab) return;
		scrollbarGrab = false;
		rePinIfNear();
		// Released away from the live edge: keep the re-pin affordance up.
		if (!pinned) setJumpVisible(true);
	};
	const onScrollKeyDown = (e: KeyboardEvent) => {
		// Bubbles from focused descendants (buttons, links, details). Scroll
		// keys are handled MANUALLY: native keyboard paging smooth-scrolls,
		// and during the animation the position lingers near the bottom, so a
		// deferred pin check would re-pin and the re-snap would kill the
		// animation — the same async race the synchronous gestures exist to
		// avoid.
		const onInteractive = (e.target as HTMLElement).closest(
			"button, a, input, textarea, select, summary",
		);
		const page = container.clientHeight;
		switch (e.key) {
			case "PageUp":
				e.preventDefault();
				unpin();
				container.scrollTop = Math.max(0, container.scrollTop - page);
				break;
			case "PageDown":
				e.preventDefault();
				container.scrollTop += page; // gesture lands → re-pin in the band
				rePinIfNear();
				break;
			case "ArrowUp":
				e.preventDefault();
				unpin();
				container.scrollTop = Math.max(0, container.scrollTop - 40);
				break;
			case "ArrowDown":
				e.preventDefault();
				container.scrollTop += 40;
				rePinIfNear();
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
				setPinned(true);
				setJumpVisible(false);
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
		if (container.scrollTop < lastTouchTop)
			unpin(); // finger dragged down: content moves up
		else rePinIfNear(); // finger dragged up: re-pin once inside the band
		lastTouchTop = container.scrollTop;
	};
	onMount(() => {
		// The single re-snap mechanism (see the module comment): content
		// observation covers every growth/shrink source — streamed text, tool
		// output, mode switches, run-row toggles, image decodes, soften
		// re-parses; container observation covers viewport resizes that change
		// clientHeight without a content change. Snapping synchronously in the
		// callback (post-layout, pre-paint) lands in the same frame; a pinned
		// stream can never drift, and an unpinned one is never touched.
		const ro = new ResizeObserver(() => {
			if (pinned) snapToBottom();
		});
		ro.observe(container);
		ro.observe(content);
		container.addEventListener("wheel", onWheelRedirect, { passive: false });
		container.addEventListener("mousedown", onScrollbarMouseDown);
		container.addEventListener("keydown", onScrollKeyDown);
		container.addEventListener("touchstart", onTouchStart, { passive: true });
		container.addEventListener("touchmove", onTouchMove, { passive: true });
		document.addEventListener("mouseup", onMouseUp);
		onCleanup(() => {
			ro.disconnect();
			container.removeEventListener("wheel", onWheelRedirect);
			container.removeEventListener("mousedown", onScrollbarMouseDown);
			container.removeEventListener("keydown", onScrollKeyDown);
			container.removeEventListener("touchstart", onTouchStart);
			container.removeEventListener("touchmove", onTouchMove);
			document.removeEventListener("mouseup", onMouseUp);
		});
	});
	return {
		containerRef: (el: HTMLDivElement) => {
			container = el;
		},
		contentRef: (el: HTMLDivElement) => {
			content = el;
		},
		jumpVisible,
		jumpToBottom,
	};
}
