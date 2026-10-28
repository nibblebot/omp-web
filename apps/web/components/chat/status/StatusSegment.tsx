import type { Component, JSX } from "solid-js";
import { showTouchHint } from "../../../store/touch-hint";

// Declarative segment button (session config bar, main header): unifies the repeated
// `segment segment-button` + active/hover/title boilerplate. `class` adds
// variant classes (e.g. "badge goal-badge", "session-name"). `readOnly` renders
// a plain `segment` span for display-only values (no tab stop, no hover state);
// a tap on one shows its `title` as a toast on touch, where tooltips do not exist.
export const StatusSegment: Component<{
	class?: string;
	title?: string;
	dataLevel?: string;
	ariaLabel?: string;
	active?: boolean;
	readOnly?: boolean;
	onClick?: () => void;
	/** The button element, for a popover anchored to the segment. */
	ref?: (el: HTMLButtonElement) => void;
	/** Marks the segment as the trigger of an anchored popover; `expanded` reports whether it is open. */
	popover?: { expanded: boolean };
	onContextMenu?: (e: MouseEvent) => void;
	children: JSX.Element;
}> = (props) =>
	props.readOnly ? (
		<span
			class={props.class ? `segment ${props.class}` : "segment"}
			data-level={props.dataLevel}
			title={props.title}
			aria-label={props.ariaLabel}
			onClick={() => showTouchHint(props.title)}
		>
			{props.children}
		</span>
	) : (
		<button
			class={props.class ? `segment segment-button ${props.class}` : "segment segment-button"}
			classList={{ active: !!props.active }}
			ref={props.ref}
			aria-haspopup={props.popover ? "dialog" : undefined}
			aria-expanded={props.popover?.expanded}
			data-level={props.dataLevel}
			title={props.title}
			aria-label={props.ariaLabel}
			onClick={props.onClick}
			onContextMenu={props.onContextMenu}
		>
			{props.children}
		</button>
	);
