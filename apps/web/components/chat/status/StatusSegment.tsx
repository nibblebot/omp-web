import type { Component, JSX } from "solid-js";

// Declarative segment button (session config bar, main header): unifies the repeated
// `segment segment-button` + active/hover/title boilerplate. `class` adds
// variant classes (e.g. "badge goal-badge", "session-name").
export const StatusSegment: Component<{
	class?: string;
	title?: string;
	dataLevel?: string;
	ariaLabel?: string;
	active?: boolean;
	onClick?: () => void;
	onContextMenu?: (e: MouseEvent) => void;
	children: JSX.Element;
}> = (props) => (
	<button
		class={props.class ? `segment segment-button ${props.class}` : "segment segment-button"}
		classList={{ active: !!props.active }}
		data-level={props.dataLevel}
		title={props.title}
		aria-label={props.ariaLabel}
		onClick={props.onClick}
		onContextMenu={props.onContextMenu}
	>
		{props.children}
	</button>
);
