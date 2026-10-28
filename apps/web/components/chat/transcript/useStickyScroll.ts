import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { setState, state } from "../../../state";

// Right-edge hit zone treated as an inner scroller's own scrollbar: wheel
// there (or Alt+wheel anywhere over it) scrolls the inner area, not the session.
const INNER_SCROLLBAR_PX = 14;

// Re-pin band: within this many px of the live edge, a DOWNWARD gesture
// re-engages stickiness. Generous so trackpads/scrollbars don't need an exact
// bottom hit; small enough that a mid-stream scroll-up escapes cleanly.
const RE_PIN_DISTANCE_PX = 80;

/** Geometry + bookkeeping the scroll-event unpin rule reads. */
export interface ScrollUnpinInput {
	pinned: boolean;
	scrollHeight: number;
	scrollTop: number;
	clientHeight: number;
	/** scrollTop right after our own last snapToBottom write (null before any). */
	snapTop: number | null;
}

/**
 * The ONLY thing a scroll event may decide: whether a pinned viewport was
 * moved away from the live edge by something other than a gesture (a
 * programmatic jump: scrollIntoView, find-in-page, an anchor link). True when
 * the view is pinned, sits more than one viewport above the bottom, and the
 * event is not the echo of our own snap (scrollTop still equals what the snap
 * left; content that grew after the snap, before the event, must not read as
 * the user leaving). A browser clamp or a shrink moves scrollTop toward the
 * bottom by far less than a viewport, so it can never qualify. Never yields
 * a re-pin.
 */
export function shouldUnpinOnScroll(m: ScrollUnpinInput): boolean {
	if (!m.pinned) return false;
	if (m.snapTop !== null && m.scrollTop === m.snapTop) return false;
	return m.scrollHeight - m.scrollTop - m.clientHeight > m.clientHeight;
}

/**
 * Imperative pin/unpin/gesture machinery for the message stream. Hands back
 * the container + content refs, the jump-to-bottom visibility signal, and the
 * jump button's click.
 *
 * Pin state is owned by synchronous gesture handlers; scroll events never
 * RE-PIN (and never touch pin state except for the single unpin-only rule
 * below). Up-gestures (wheel-up, scrollbar grab, upward touch drag,
 * up-keys) unpin; down-gestures that land inside the re-pin band, plus the
 * jump button and session switches, re-pin. This closes the two failure
 * classes of distance-threshold scroll-event reconciliation:
 *
 * 1. A scroll event can't re-pin, since it can't distinguish a user scrolling
 *    down from a browser clamp (StreamingTail's soften re-parse or a shrink
 *    shifting scrollTop). A small scroll-up during streaming can never be
 *    yanked back by the next event. Escape is irrevocable until the user
 *    gestures down into the band.
 * 2. Content growth can't move an unpinned viewport; snaps run only while
 *    pinned, so a pinned stream follows the live edge and an escaped one
 *    stays exactly where the user left it.
 *
 * The one exception: while pinned, a scroll event that leaves the bottom by
 * MORE than one viewport unpins (shouldUnpinOnScroll). Gestures can't see
 * programmatic jumps (scrollIntoView, find-in-page) into content-visibility
 * placeholders; without this, the jump changes the content size as items
 * render and the pinned ResizeObserver snaps straight back to the bottom.
 * It preserves class 1 because it can only unpin, never re-pin, and a clamp
 * or shrink moves the view by less than a viewport. It preserves class 2
 * because it only ever stops snaps. Our own snaps land at the bottom (and
 * their scroll echo is recognised by scrollTop === the post-snap value), so
 * they can't trip it.
 *
 * While pinned, a ResizeObserver pair re-snaps the viewport to the live edge.
 * Observing the CONTENT element catches every growth source with one
 * mechanism: reveal-paced live text (each rAF flush grows the tail),
 * streamed tool/bash output (in-place item mutations that never change
 * items.length), Ctrl+O, image
 * decodes, font reflows, StreamingTail's 160ms soften re-parse. Observing the
 * CONTAINER catches viewport resizes (window/sidebar) that change
 * clientHeight without touching content. RO callbacks run after layout,
 * before paint, so a synchronous snap lands in the same frame as the change
 * (a store-signal effect would fire BEFORE child effects like StreamingTail's
 * innerHTML write and read a stale scrollHeight); scrollTop writes can't feed
 * back because neither observed box changes size. Starts pinned so a fresh
 * attach/history load lands at the bottom.
 *
 * `mirrorSession` (default on) is the main transcript's tie to the store
 * (`chatPinned`, `answerUnviewed`); a secondary stream (a subagent's) passes
 * false so its scrolling never marks the main answer viewed.
 */
export function useStickyScroll(options: { mirrorSession?: boolean } = {}): {
	containerRef: (el: HTMLDivElement) => void;
	contentRef: (el: HTMLDivElement) => void;
	jumpVisible: () => boolean;
	jumpToBottom: () => void;
	/** Leave the live edge: a programmatic jump elsewhere (the stream mounts older cards first, which would otherwise re-snap a pinned viewport). */
	release: () => void;
} {
	let container!: HTMLDivElement;
	let content!: HTMLDivElement;
	let pinned = true;
	let rePinRaf = 0;
	const [jumpVisible, setJumpVisible] = createSignal(false);
	// Mirror pin state into the store: agent_end (apps/web/store/chat.ts) reads
	// chatPinned to decide whether the finished answer was viewed (unviewed →
	// the roster's light-blue unreviewed dot), and every re-pin clears the flag.
	// The local var stays for the synchronous reads inside the handlers.
	const setPinned = (p: boolean) => {
		pinned = p;
		if (options.mirrorSession === false) return;
		setState("chatPinned", p);
		if (p) setState("answerUnviewed", false);
	};
	const nearBottom = () =>
		container.scrollHeight - container.scrollTop - container.clientHeight < RE_PIN_DISTANCE_PX;
	// Leave the live edge: cancels a pending wheel-down re-pin check, which
	// must not fire after the escape (the viewport is still inside the band
	// until the wheel-up lands, so it would re-pin and snap back: the "can't
	// unstick" race at rAF granularity).
	const escapeBottom = () => {
		if (rePinRaf !== 0) {
			cancelAnimationFrame(rePinRaf);
			rePinRaf = 0;
		}
		setPinned(false);
		setJumpVisible(true);
	};
	const unpin = () => {
		// No room above → the gesture can't move the viewport; stay pinned.
		if (container.scrollTop <= 0) return;
		escapeBottom();
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
	let snapTop: number | null = null;
	const snapToBottom = () => {
		container.scrollTop = container.scrollHeight;
		// Read back the clamped result: the scroll event this write queues is
		// recognised by scrollTop still equaling it (see shouldUnpinOnScroll).
		snapTop = container.scrollTop;
	};
	// The single scroll-event rule: unpin-only (see the module comment).
	const onScroll = () => {
		if (
			!shouldUnpinOnScroll({
				pinned,
				scrollHeight: container.scrollHeight,
				scrollTop: container.scrollTop,
				clientHeight: container.clientHeight,
				snapTop,
			})
		)
			return;
		escapeBottom();
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
	// matter where the previous session was scrolled (currentWorkspaceId changes
	// on every attach/switch; the effect above then owns the snap as history
	// frames land).
	let lastSessionId = state.currentWorkspaceId;
	createEffect(() => {
		const id = state.currentWorkspaceId;
		if (id === lastSessionId) return;
		lastSessionId = id;
		setPinned(true);
		setJumpVisible(false);
	});
	// Session-first wheel scrolling. Tool bodies with their own vertical
	// scrollbar (search results; any future capped output) otherwise trap the
	// wheel: hovering them scrolls the inner area, and the session only moves
	// once the inner scroller hits its boundary. Redirect instead. Wheel over
	// an inner scroller scrolls the session, unless the user explicitly asks
	// for inner scroll: Alt+wheel, or wheel over the scroller's own scrollbar.
	// At the scroller's boundary the event falls through to native scroll
	// chaining, which moves the session anyway. Wheel-up unpins synchronously
	// in every path; wheel-down schedules the band re-pin check.
	//
	// Only the redirect has to cancel a wheel event, and a non-passive wheel
	// listener makes the browser wait for the main thread before it scrolls
	// anything under it. So the container listens passively (pin bookkeeping
	// only, never blocks) and the non-passive redirect sits on the one inner
	// scroller the pointer is over, from the moment it enters.
	const wheelUnpin = (e: WheelEvent) => {
		if (e.deltaY < 0) unpin();
	};
	// Wheel events the inner scroller's redirect already did the pin bookkeeping for.
	const redirected = new WeakSet<Event>();
	const onInnerWheel = (e: WheelEvent) => {
		redirected.add(e);
		// Alt+wheel is the explicit "scroll this inner area" gesture; the other
		// modifiers are unrelated gestures (Ctrl zoom, Shift horizontal).
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (e.deltaY === 0) return; // horizontal-only wheel passes through
		// Wheel-up that will move the SESSION unpins synchronously (see the
		// pin comment above); wheel-down re-pins once it lands in the band.
		if (e.deltaY > 0) scheduleRePinCheck();
		const scroller = e.currentTarget as HTMLElement;
		if (scroller.scrollHeight <= scroller.clientHeight + 1) {
			wheelUnpin(e);
			return; // nothing left to capture the wheel → native session scroll
		}
		const atBoundary =
			e.deltaY > 0
				? scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
				: scroller.scrollTop <= 0;
		if (atBoundary) {
			wheelUnpin(e);
			return; // native chaining moves the session
		}
		const rect = scroller.getBoundingClientRect();
		if (e.clientX >= rect.right - INNER_SCROLLBAR_PX) return; // over its scrollbar
		e.preventDefault();
		wheelUnpin(e);
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
	// The innermost scroller of the stream's cards at or above `target` that has
	// something to scroll, if any.
	const innerScrollerOf = (target: EventTarget | null): HTMLElement | null => {
		let el = target instanceof HTMLElement ? target : null;
		while (el && el !== container) {
			const overflowY = getComputedStyle(el).overflowY;
			if (
				(overflowY === "auto" || overflowY === "scroll") &&
				el.scrollHeight > el.clientHeight + 1
			) {
				return el;
			}
			el = el.parentElement;
		}
		return null;
	};
	let hoveredScroller: HTMLElement | null = null;
	let hoveredTarget: EventTarget | null = null;
	const redirectWheelOver = (target: EventTarget | null) => {
		if (target === hoveredTarget) return;
		hoveredTarget = target;
		const next = innerScrollerOf(target);
		if (next === hoveredScroller) return;
		hoveredScroller?.removeEventListener("wheel", onInnerWheel);
		hoveredScroller = next;
		next?.addEventListener("wheel", onInnerWheel, { passive: false });
	};
	const onPointerOver = (e: PointerEvent) => redirectWheelOver(e.target);
	const onPointerLeave = () => redirectWheelOver(null);
	const onWheel = (e: WheelEvent) => {
		// A scroller that appeared under a resting pointer gets its redirect from the next tick on.
		redirectWheelOver(e.target);
		if (redirected.has(e)) return;
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (e.deltaY === 0) return; // horizontal-only wheel passes through
		if (e.deltaY > 0) scheduleRePinCheck();
		wheelUnpin(e); // nothing captures the wheel → native session scroll
	};
	// Scrollbar drags, scroll keys, and touch drags are the other pin
	// gestures (wheel is handled in onWheel and onInnerWheel). All unpin/re-pin
	// SYNCHRONOUSLY, since waiting for a scroll event races the streaming snaps.
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
		// animation, the same async race the synchronous gestures exist to
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
				snapToBottom();
				break;
			case " ":
				// Space ACTIVATES focused buttons/links; only Shift+Space (page
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
		// observation covers every growth/shrink source: streamed text, tool
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
		container.addEventListener("wheel", onWheel, { passive: true });
		container.addEventListener("pointerover", onPointerOver, { passive: true });
		container.addEventListener("pointerleave", onPointerLeave, { passive: true });
		container.addEventListener("mousedown", onScrollbarMouseDown);
		container.addEventListener("keydown", onScrollKeyDown);
		container.addEventListener("touchstart", onTouchStart, { passive: true });
		container.addEventListener("touchmove", onTouchMove, { passive: true });
		container.addEventListener("scroll", onScroll, { passive: true });
		document.addEventListener("mouseup", onMouseUp);
		onCleanup(() => {
			ro.disconnect();
			container.removeEventListener("wheel", onWheel);
			container.removeEventListener("pointerover", onPointerOver);
			container.removeEventListener("pointerleave", onPointerLeave);
			hoveredScroller?.removeEventListener("wheel", onInnerWheel);
			container.removeEventListener("mousedown", onScrollbarMouseDown);
			container.removeEventListener("keydown", onScrollKeyDown);
			container.removeEventListener("touchstart", onTouchStart);
			container.removeEventListener("touchmove", onTouchMove);
			container.removeEventListener("scroll", onScroll);
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
		release: escapeBottom,
	};
}
