import type { Component, JSX } from "solid-js";
import { XIcon } from "./icons";

export interface DockPaneProps {
	title: string;
	/** Current width in px; the layout width itself comes from the `--dock-w` variable. */
	width: number;
	minWidth: number;
	maxWidth: number;
	onWidth: (px: number) => void;
	onClose: () => void;
	actions?: JSX.Element;
	children?: JSX.Element;
}

const KEY_STEP = 16;

/**
 * Shell-hosted right dock. Domain-free: the caller supplies title, width, and
 * body. Below 768px it covers the whole viewport and offers a Back button.
 */
export const DockPane: Component<DockPaneProps> = (props) => {
	let dragStartX = 0;
	let dragStartWidth = 0;

	const clamp = (px: number): number =>
		Math.min(props.maxWidth, Math.max(props.minWidth, Math.round(px)));

	const onPointerDown = (event: PointerEvent) => {
		const handle = event.currentTarget as HTMLElement;
		dragStartX = event.clientX;
		dragStartWidth = props.width;
		handle.setPointerCapture(event.pointerId);
	};

	const onPointerMove = (event: PointerEvent) => {
		const handle = event.currentTarget as HTMLElement;
		if (!handle.hasPointerCapture(event.pointerId)) return;
		// The separator sits on the dock's left edge: dragging left widens the dock.
		props.onWidth(clamp(dragStartWidth - (event.clientX - dragStartX)));
	};

	const onSeparatorKey = (event: KeyboardEvent) => {
		if (event.key === "ArrowLeft") {
			event.preventDefault();
			props.onWidth(clamp(props.width + KEY_STEP));
		} else if (event.key === "ArrowRight") {
			event.preventDefault();
			props.onWidth(clamp(props.width - KEY_STEP));
		}
	};

	// Esc inside the pane closes it, unless an inner control already handled it.
	const onPaneKey = (event: KeyboardEvent) => {
		if (event.key !== "Escape" || event.defaultPrevented) return;
		event.preventDefault();
		props.onClose();
	};

	return (
		<aside class="dock-pane" aria-label={props.title} onKeyDown={onPaneKey}>
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
				onKeyDown={onSeparatorKey}
			/>
			<header class="dock-header">
				<button type="button" class="dock-back" onClick={() => props.onClose()}>
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
			<div class="dock-body">{props.children}</div>
		</aside>
	);
};
