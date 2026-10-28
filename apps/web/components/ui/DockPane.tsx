import { createEffect, on, onCleanup, onMount, type Component, type JSX } from "solid-js";
import type { PresencePhase } from "../../motion/presence";
import { focusOrigin, pageFocusFallback, resolveFocusReturn } from "./focus";
import { XIcon } from "./icons";

export interface DockPaneProps {
	title: string;
	/** Current width in px; the layout width itself comes from the `--dock-w` variable. */
	width: number;
	minWidth: number;
	maxWidth: number;
	/** The width to keep: once when a drag ends (the pane follows the pointer itself meanwhile), and per keyboard step. */
	onWidth: (px: number) => void;
	onClose: () => void;
	/** Back button and Esc; defaults to `onClose`. The close button always calls `onClose`. */
	onBack?: () => void;
	actions?: JSX.Element;
	/** Body without padding or scrolling, for a panel that lays out and scrolls itself (agent pane). */
	flush?: boolean;
	children?: JSX.Element;
	/**
	 * Motion phase from the host's presence (`data-motion`): "enter" and "exit"
	 * hold the off-screen state, and an exiting pane is inert and hands focus
	 * back at once. Omitted: a static pane with no motion.
	 */
	phase?: PresencePhase;
	/** Lay the pane over the main pane at the right edge instead of in the flex row. */
	overlay?: boolean;
	/** Fade title, actions and body out (the host swaps the content while it is faded). */
	swapping?: boolean;
	/** Receives the pane element, and the body element the content fade runs on. */
	paneRef?: (el: HTMLElement) => void;
	bodyRef?: (el: HTMLElement) => void;
}

const KEY_STEP = 16;

/**
 * Shell-hosted right dock. Domain-free: the caller supplies title, width, and
 * body. Below 1024px (the sidebar's drawer breakpoint) it covers the whole viewport
 * inside the safe-area insets and offers a Back button.
 */
export const DockPane: Component<DockPaneProps> = (props) => {
	let pane!: HTMLElement;
	let dragStartX = 0;
	let dragStartWidth = 0;
	// The element that had focus before the dock opened; restored when it closes.
	let previousFocus: HTMLElement | null = null;

	onMount(() => {
		previousFocus = focusOrigin();
	});
	// Hand focus back when it is still inside the pane or was lost with it (Esc, Back,
	// close button). Focus that moved to another control on purpose is left alone.
	// Runs once, when the close starts: an exiting pane is inert while it slides out.
	let focusReturned = false;
	const returnFocus = () => {
		if (focusReturned) return;
		focusReturned = true;
		const origin = previousFocus;
		previousFocus = null;
		const active = document.activeElement;
		if (active && active !== document.body && !pane.contains(active)) return;
		resolveFocusReturn(origin, pageFocusFallback)?.focus();
	};
	onCleanup(returnFocus);
	createEffect(
		on(
			() => props.phase,
			(phase) => phase === "exit" && returnFocus(),
			{ defer: true },
		),
	);

	const clamp = (px: number): number =>
		Math.min(props.maxWidth, Math.max(props.minWidth, Math.round(px)));

	// A drag moves the pane's own width, once per frame, and hands the final width to `onWidth` when it ends:
	// a write that went through the store would restyle the whole document (the width custom property lives
	// on the root) and write storage on every pointermove.
	let dragHandle: HTMLElement | undefined;
	let dragWidth: number | undefined;
	let dragFrame = 0;
	const paintDrag = () => {
		dragFrame = 0;
		if (dragWidth === undefined) return;
		pane.style.width = `${dragWidth}px`;
		dragHandle?.setAttribute("aria-valuenow", String(dragWidth));
	};
	const endDrag = () => {
		cancelAnimationFrame(dragFrame);
		dragFrame = 0;
		const width = dragWidth;
		dragWidth = undefined;
		dragHandle = undefined;
		if (width === undefined) return;
		props.onWidth(width);
		pane.style.removeProperty("width");
	};
	onCleanup(() => cancelAnimationFrame(dragFrame));

	const onPointerDown = (event: PointerEvent) => {
		const handle = event.currentTarget as HTMLElement;
		dragStartX = event.clientX;
		// The rendered width: dock.css caps a saved width to the viewport.
		dragStartWidth = pane.offsetWidth;
		dragHandle = handle;
		handle.setPointerCapture(event.pointerId);
	};

	const onPointerMove = (event: PointerEvent) => {
		const handle = event.currentTarget as HTMLElement;
		if (!handle.hasPointerCapture(event.pointerId)) return;
		// The separator sits on the dock's left edge: dragging left widens the dock.
		dragWidth = clamp(dragStartWidth - (event.clientX - dragStartX));
		dragFrame ||= requestAnimationFrame(paintDrag);
	};

	const onSeparatorKey = (event: KeyboardEvent) => {
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			props.onWidth(clamp(pane.offsetWidth + KEY_STEP));
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			props.onWidth(clamp(pane.offsetWidth - KEY_STEP));
		}
	};

	// Esc inside the pane steps back (or closes), unless an inner control already handled it.
	const back = () => (props.onBack ?? props.onClose)();
	const onPaneKey = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		back();
	};

	return (
		<aside
			ref={(el) => {
				pane = el;
				props.paneRef?.(el);
			}}
			class="dock-pane"
			aria-label={props.title}
			data-motion={props.phase}
			data-overlay={props.overlay ? "" : undefined}
			data-swapping={props.swapping ? "" : undefined}
			inert={props.phase === "exit"}
			onKeyDown={onPaneKey}
		>
			<div
				class="dock-resizer"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize panel"
				aria-valuemin={props.minWidth}
				aria-valuemax={props.maxWidth}
				aria-valuenow={props.width}
				tabIndex={0}
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onLostPointerCapture={endDrag}
				onKeyDown={onSeparatorKey}
			/>
			<header class="dock-header">
				<button type="button" class="dock-back" onClick={back}>
					Back
				</button>
				<h2 class="dock-title">{props.title}</h2>
				<div class="dock-actions">{props.actions}</div>
				<button
					type="button"
					class="dock-close"
					aria-label="Close panel"
					onClick={() => props.onClose()}
				>
					<XIcon />
				</button>
			</header>
			<div
				class="dock-body"
				classList={{ "dock-body--flush": props.flush === true }}
				ref={(el) => props.bodyRef?.(el)}
			>
				{props.children}
			</div>
		</aside>
	);
};
