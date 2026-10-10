import { Show, type Component, type JSX } from "solid-js";

interface CardProps {
	/** Header row content: a `.card-header` div, or the `<summary>` when collapsible. */
	header?: JSX.Element;
	/** Render as `<details>`; the header becomes the always-visible `<summary>`. */
	collapsible?: boolean;
	/** `<details>` open state (collapsible only). Undefined leaves it uncontrolled. */
	open?: boolean;
	/** `<details>` toggle (collapsible only); check `e.isTrusted` to tell user toggles apart. */
	onToggle?: JSX.EventHandler<HTMLDetailsElement, Event>;
	class?: string;
	classList?: Record<string, boolean | undefined>;
	children?: JSX.Element;
}

/** Bordered panel surface with an optional header row; domain-free. */
export const Card: Component<CardProps> = (props) => {
	const cardClass = () => (props.class ? `card ${props.class}` : "card");
	return (
		<Show
			when={props.collapsible}
			fallback={
				<div class={cardClass()} classList={props.classList}>
					<Show when={props.header}>
						<div class="card-header">{props.header}</div>
					</Show>
					{props.children}
				</div>
			}
		>
			<details
				class={cardClass()}
				classList={props.classList}
				open={props.open}
				onToggle={(e) => props.onToggle?.(e)}
			>
				<summary class="card-header">{props.header}</summary>
				{props.children}
			</details>
		</Show>
	);
};
