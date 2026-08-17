import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { state } from "../../state";

// Right-edge hit zone treated as an inner scroller's own scrollbar: wheel
// there (or Alt+wheel anywhere over it) scrolls the inner area, not the session.
const INNER_SCROLLBAR_PX = 14;

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

/**
 * Imperative pin/unpin/wheel/scrollbar/keyboard/touch scroll machinery for
 * the message stream. Hands back the container ref, the jump-to-bottom
 * visibility signal, and the actions MessageList binds (the scroll handler
 * and the jump button's click).
 */
export function useStickyScroll(): {
	containerRef: (el: HTMLDivElement) => void;
	jumpVisible: () => boolean;
	jumpToBottom: () => void;
	applyPinState: () => void;
} {
	let container!: HTMLDivElement;
	let pinned = true;
	let pinCheckRaf = 0;
	const [jumpVisible, setJumpVisible] = createSignal(false);
	const nearBottom = () =>
		container.scrollHeight - container.scrollTop - container.clientHeight < PIN_DISTANCE_PX;
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
		// live.rev is bumped on every live-block mutation; subscribing to it
		// (instead of mapping block text lengths per flush) avoids allocating
		// a lengths array on every rAF flush.
		state.live.rev;
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
	return {
		containerRef: (el: HTMLDivElement) => {
			container = el;
		},
		jumpVisible,
		jumpToBottom,
		applyPinState,
	};
}
