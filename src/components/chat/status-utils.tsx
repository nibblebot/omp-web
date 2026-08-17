import type { Component, JSX } from "solid-js";

// Declarative status-bar segment button: unifies the repeated
// `segment segment-button` + active/hover/title boilerplate. `class` adds
// variant classes (e.g. "badge goal-badge", "session-name").
export const Segment: Component<{
	class?: string;
	title?: string;
	ariaLabel?: string;
	active?: boolean;
	onClick?: () => void;
	onContextMenu?: (e: MouseEvent) => void;
	children: JSX.Element;
}> = (props) => (
	<button
		class={props.class ? `segment segment-button ${props.class}` : "segment segment-button"}
		classList={{ active: !!props.active }}
		title={props.title}
		aria-label={props.ariaLabel}
		onClick={props.onClick}
		onContextMenu={props.onContextMenu}
	>
		{props.children}
	</button>
);
