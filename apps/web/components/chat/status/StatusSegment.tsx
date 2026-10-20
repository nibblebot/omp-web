import type { Component, JSX } from "solid-js";

// Declarative segment button (session config bar, main header): unifies the repeated
// `segment segment-button` + active/hover/title boilerplate. `class` adds
// variant classes (e.g. "badge goal-badge", "session-name"). `readOnly` renders
// a plain `segment` span for display-only values (no tab stop, no hover state).
export const StatusSegment: Component<{
	class?: string;
	title?: string;
	dataLevel?: string;
	ariaLabel?: string;
	active?: boolean;
	readOnly?: boolean;
	onClick?: () => void;
	onContextMenu?: (e: MouseEvent) => void;
	children: JSX.Element;
}> = (props) =>
	props.readOnly ? (
		<span
			class={props.class ? `segment ${props.class}` : "segment"}
			data-level={props.dataLevel}
			title={props.title}
			aria-label={props.ariaLabel}
		>
			{props.children}
		</span>
	) : (
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
