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
	/** Reflected as `data-status` on the card root for status-driven styling. */
	status?: string;
	/** Extra `data-*` attributes on the card root, keyed without the `data-` prefix (`{ "tool-call-id": id }`); undefined values are omitted. */
	data?: Record<string, string | undefined>;
	children?: JSX.Element;
}

/** Bordered panel surface with an optional header row; domain-free. */
export const Card: Component<CardProps> = (props) => {
	const cardClass = () => (props.class ? `card ${props.class}` : "card");
	const dataAttrs = () =>
		Object.fromEntries(
			Object.entries(props.data ?? {}).map(([key, value]) => [`data-${key}`, value]),
		);
	return (
		<Show
			when={props.collapsible}
			fallback={
				<div
					class={cardClass()}
					data-status={props.status}
					classList={props.classList}
					{...dataAttrs()}
				>
					<Show when={props.header}>
						<div class="card-header">{props.header}</div>
					</Show>
					{props.children}
				</div>
			}
		>
			<details
				class={cardClass()}
				data-status={props.status}
				classList={props.classList}
				{...dataAttrs()}
				open={props.open}
				onToggle={(e) => props.onToggle?.(e)}
			>
				<summary class="card-header">{props.header}</summary>
				{props.children}
			</details>
		</Show>
	);
};
